import {getRedirectUri, getClientId, Constants} from "./utils.js";
import {apiStatistics} from "./api-statistics.js";

export let defaultApiVersion = "66.0";
export let apiVersion = localStorage.getItem("apiVersion") == null ? defaultApiVersion : localStorage.getItem("apiVersion");

export let sessionError;
const clientId = "Salesforce Inspector Ultra";

export let sfConn = {

  async getSession(sfHost, prefetchedSession) {
    const url = new URL(window.location.href);
    const searchParams = new URLSearchParams(url.search);
    const authorizationCode = searchParams.get("code");
    const state = searchParams.get("state");

    // If we have an authorization code, extract sfHost from state parameter
    if (authorizationCode && state) {
      try {
        const stateData = JSON.parse(decodeURIComponent(state));
        sfHost = stateData.sfHost;
      } catch (error) {
        console.error("Error parsing state parameter:", error);
      }
    }

    console.log("[SF-DBG getSession] ENTRY. input sfHost:", sfHost, "prefetchedSession:", prefetchedSession ? "YES" : "NO", "location:", window.location.href);
    sfHost = getMyDomain(sfHost);
    console.log("[SF-DBG getSession] after getMyDomain:", sfHost);
    const oldToken = localStorage.getItem(sfHost + Constants.ACCESS_TOKEN);
    console.log("[SF-DBG getSession] stored OAuth token exists?", !!oldToken, "key:", sfHost + Constants.ACCESS_TOKEN);
    this.instanceHostname = sfHost;

    // Check if this is an OAuth callback with authorization code (PKCE flow)
    if (authorizationCode) {
      try {
        const codeVerifier = localStorage.getItem(sfHost + Constants.CODE_VERIFIER);
        if (!codeVerifier) {
          throw new Error("Code verifier not found. Please restart the authorization flow.");
        }

        // Exchange authorization code for access token
        const accessToken = await this.exchangeCodeForToken(sfHost, authorizationCode, codeVerifier);
        this.sessionId = accessToken;
        localStorage.setItem(sfHost + Constants.ACCESS_TOKEN, accessToken);

        //send message to popup so that it can update the token
        chrome.runtime.sendMessage({message: "tokenUpdated", sfHost});

        // Clean up code verifier
        localStorage.removeItem(sfHost + Constants.CODE_VERIFIER);

        // Clean up the URL by removing the code and state parameters
        const cleanUrl = url.origin + url.pathname + "?host=" + sfHost + url.hash;
        window.history.replaceState({}, document.title, cleanUrl);
      } catch (error) {
        console.error("Error exchanging authorization code for token:", error);
        sessionError = {text: error.message, type: "error", icon: "error"};
        showToastBanner();
      }
    } else if (oldToken) {
      console.log("[SF-DBG getSession] Using stored OAuth token (first 20):", oldToken.substring(0, 20) + "...");
      this.sessionId = oldToken;
    } else if (prefetchedSession) {
      // Safari: session was pre-fetched by the content script and passed via postMessage
      console.log("[SF-DBG getSession] Using prefetched session from content script. hostname:", prefetchedSession.hostname, "key (first 20):", prefetchedSession.key?.substring(0, 20) + "...");
      this.instanceHostname = getMyDomain(prefetchedSession.hostname);
      this.sessionId = prefetchedSession.key;
    } else {
      console.log("[SF-DBG getSession] No stored token, requesting cookie from background. sfHost:", sfHost);
      let message = await new Promise(resolve =>
        chrome.runtime.sendMessage({message: "getSession", sfHost}, resolve));
      console.log("[SF-DBG getSession] Background response:", message ? {hostname: message.hostname, keyPrefix: message.key?.substring(0, 20) + "..."} : "null");
      if (message) {
        this.instanceHostname = getMyDomain(message.hostname);
        console.log("[SF-DBG getSession] instanceHostname (after getMyDomain):", this.instanceHostname);
        this.sessionId = message.key;
      }
    }
    if (localStorage.getItem(sfHost + "_trialExpirationDate") == null) {
      sfConn.rest("/services/data/v" + apiVersion + "/query/?q=SELECT+IsSandbox,+InstanceName+,TrialExpirationDate+FROM+Organization").then(res => {
        localStorage.setItem(sfHost + "_isSandbox", res.records[0].IsSandbox);
        localStorage.setItem(sfHost + "_orgInstance", res.records[0].InstanceName);
        localStorage.setItem(sfHost + "_trialExpirationDate", res.records[0].TrialExpirationDate);
      });
    }
    return this.sessionId;
  },

  async exchangeCodeForToken(sfHost, authorizationCode, codeVerifier) {
    const redirectUri = getRedirectUri("data-export.html");
    const clientId = getClientId(sfHost);

    // Validate redirect URI was successfully generated
    if (!redirectUri || !redirectUri.includes("-extension://")) {
      throw new Error("Failed to generate redirect URI. Extension context may be invalidated. Please reload this page and try again.");
    }

    const tokenUrl = `https://${sfHost}/services/oauth2/token`;
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error_description || "Failed to exchange code for token");
    }

    const tokenData = await response.json();
    return tokenData.access_token;
  },

  async rest(url, {logErrors = true, method = "GET", api = "normal", body = undefined, bodyType = "json", responseType = "json", headers = {}, progressHandler = null, useCache = true} = {}, rawResponse) {
    if (!this.instanceHostname) {
      throw new Error("Instance Hostname not found");
    }

    // Track API call start time for statistics
    const startTime = performance.now();

    let xhr = new XMLHttpRequest();
    if (useCache) {
      url += (url.includes("?") ? "&" : "?") + "cache=" + Math.random();
    }
    const sfHost = "https://" + this.instanceHostname;
    const fullUrl = new URL(url, sfHost);

    // Safari: safari-web-extension:// origin is blocked by Salesforce CORS; proxy through background service worker
    if (typeof location !== "undefined" && location.protocol === "safari-web-extension:") {
      console.log("[SF-DBG rest] Safari proxy path. sessionId (first 20):", this.sessionId?.substring(0, 20) + "...", "instanceHostname:", this.instanceHostname, "url:", url);
      const proxyHeaders = {};
      if (api === "bulk") {
        proxyHeaders["X-SFDC-Session"] = this.sessionId;
      } else {
        proxyHeaders["Authorization"] = "Bearer " + this.sessionId;
      }
      for (const [k, v] of Object.entries(headers)) proxyHeaders[k] = v;
      if (body !== undefined && !proxyHeaders["Content-Type"]) {
        proxyHeaders["Content-Type"] = "application/json; charset=UTF-8";
      }
      proxyHeaders["Sforce-Call-Options"] = `client=${clientId}`;
      const serialBody = body !== undefined ? (bodyType === "json" ? JSON.stringify(body) : body) : undefined;
      console.log("[SF-DBG rest] Sending proxyFetch to:", fullUrl.toString(), "method:", method);
      const r = await new Promise(resolve =>
        chrome.runtime.sendMessage({message: "proxyFetch", url: fullUrl.toString(), method, headers: proxyHeaders, body: serialBody}, resolve));
      const status = r?.status ?? 0;
      const duration = performance.now() - startTime;
      if (status === 0) {
        apiStatistics.trackApiCall("rest", url, method, duration, true, "Network error, offline or timeout");
        const err = new Error("Network error, offline or timeout"); err.name = "SalesforceRestError"; throw err;
      }
      let parsed = null;
      if (r.body) { try { parsed = JSON.parse(r.body); } catch { parsed = r.body; } }
      if (status >= 200 && status < 400) {
        apiStatistics.trackApiCall("rest", url, method, duration, false);
        if (responseType === "blob") {
          const blob = new Blob([r.body || ""]);
          if (rawResponse) return {status, response: blob, responseText: r.body};
          return blob;
        }
        if (rawResponse) return {status, response: parsed, responseText: r.body};
        return responseType === "json" ? parsed : r.body;
      }
      const errMsg = Array.isArray(parsed) ? parsed[0]?.message : (parsed?.message || "Error " + status);
      apiStatistics.trackApiCall("rest", url, method, duration, true, errMsg);
      const err = new Error(errMsg);
      err.name = status === 401 ? "Unauthorized" : "SalesforceRestError";
      throw err;
    }

    xhr.open(method, fullUrl.toString(), true);

    if (api == "bulk") {
      xhr.setRequestHeader("X-SFDC-Session", this.sessionId);
    } else if (api == "normal") {
      xhr.setRequestHeader("Authorization", "Bearer " + this.sessionId);
    } else {
      throw new Error("Unknown api");
    }

    // Apply custom headers first (but filter out protected headers)
    const protectedHeaders = ["Sforce-Call-Options"];
    for (let [name, value] of Object.entries(headers)) {
      if (!protectedHeaders.includes(name)) {
        xhr.setRequestHeader(name, value);
      }
    }

    // Set default Content-Type header if body is present and Content-Type not provided by custom headers
    if (body !== undefined && !headers.hasOwnProperty("Content-Type")) {
      xhr.setRequestHeader("Content-Type", "application/json; charset=UTF-8");
    }

    if (body !== undefined) {
      if (bodyType == "json") {
        body = JSON.stringify(body);
      } else if (bodyType == "raw") {
        // Do nothing
      } else {
        throw new Error("Unknown bodyType");
      }
    }

    // Set default Accept header if not provided by custom headers
    if (!headers.hasOwnProperty("Accept")) {
      xhr.setRequestHeader("Accept", "application/json; charset=UTF-8");
    }

    // Always set this header last to ensure it cannot be overridden
    xhr.setRequestHeader("Sforce-Call-Options", `client=${clientId}`);

    xhr.responseType = responseType;
    await new Promise((resolve, reject) => {
      if (progressHandler) {
        progressHandler.abort = () => {
          let err = new Error("The request was aborted.");
          err.name = "AbortError";
          reject(err);
          xhr.abort();
        };
      }

      xhr.onreadystatechange = () => {
        if (xhr.readyState == 4) {
          resolve();
        }
      };
      xhr.send(body);
    });

    // Calculate duration and track statistics
    const duration = performance.now() - startTime;
    let errorMessage = null;

    if (rawResponse){
      apiStatistics.trackApiCall("rest", url, method, duration, false);
      return xhr;
    } else if (xhr.status >= 200 && xhr.status < 400) {
      apiStatistics.trackApiCall("rest", url, method, duration, false);
      return xhr.response;
    } else if (xhr.status == 0) {
      if (!logErrors) { console.error("Received no response from Salesforce REST API", xhr); }
      errorMessage = "Network error, offline or timeout";
      apiStatistics.trackApiCall("rest", url, method, duration, true, errorMessage);
      let err = new Error();
      err.name = "SalesforceRestError";
      err.message = errorMessage;
      throw err;
    } else if (xhr.status == 401) {
      let error = xhr.response.length > 0 ? xhr.response[0].message : "New access token needed";
      errorMessage = `401 Unauthorized: ${error}`;
      //set sessionError only if user has already generated a token, which will prevent to display the error when the session is expired and api access control not configured
      if (localStorage.getItem(this.instanceHostname + Constants.ACCESS_TOKEN)){
        sessionError = {text: "Access Token Expired", title: "Generate New Token", type: "warning", icon: "warning"};
        showToastBanner();
      }
      apiStatistics.trackApiCall("rest", url, method, duration, true, errorMessage);
      let err = new Error();
      err.name = "Unauthorized";
      err.message = error;
      throw err;
    } else if (xhr.status == 403) {
      let error = xhr.response.length > 0 ? xhr.response[0].message : "Error";
      errorMessage = `403 Forbidden: ${error}`;
      sessionError = {text: error, type: "error", icon: "error"};
      showToastBanner();
      apiStatistics.trackApiCall("rest", url, method, duration, true, errorMessage);
      let err = new Error();
      err.name = "Forbidden";
      err.message = error;
      throw err;
    } else {
      if (!logErrors) { console.error("Received error response from Salesforce REST API", xhr); }
      let err = new Error();
      err.name = "SalesforceRestError";
      err.detail = xhr.response;
      try {
        errorMessage = err.detail.map(err => `${err.errorCode}: ${err.message}${err.fields && err.fields.length > 0 ? ` [${err.fields.join(", ")}]` : ""}`).join("\n");
        err.message = errorMessage;
      } catch (ex) {
        errorMessage = JSON.stringify(xhr.response);
        err.message = errorMessage;
      }
      if (!err.message) {
        errorMessage = `HTTP error ${xhr.status} ${xhr.statusText}`;
        err.message = errorMessage;
      }
      apiStatistics.trackApiCall("rest", url, method, duration, true, errorMessage);
      throw err;
    }
  },

  wsdl(apiVersion, apiName) {
    let wsdl = {
      Enterprise: {
        servicePortAddress: "/services/Soap/c/" + apiVersion,
        targetNamespaces: ' xmlns="urn:enterprise.soap.sforce.com" xmlns:sf="urn:sobject.enterprise.soap.sforce.com"',
        apiName: "Enterprise"
      },
      Partner: {
        servicePortAddress: "/services/Soap/u/" + apiVersion,
        targetNamespaces: ' xmlns="urn:partner.soap.sforce.com" xmlns:sf="urn:sobject.partner.soap.sforce.com"',
        apiName: "Partner"
      },
      Apex: {
        servicePortAddress: "/services/Soap/s/" + apiVersion,
        targetNamespaces: ' xmlns="http://soap.sforce.com/2006/08/apex"',
        apiName: "Apex"
      },
      Metadata: {
        servicePortAddress: "/services/Soap/m/" + apiVersion,
        targetNamespaces: ' xmlns="http://soap.sforce.com/2006/04/metadata"',
        apiName: "Metadata"
      },
      Tooling: {
        servicePortAddress: "/services/Soap/T/" + apiVersion,
        targetNamespaces: ' xmlns="urn:tooling.soap.sforce.com" xmlns:sf="urn:sobject.tooling.soap.sforce.com" xmlns:mns="urn:metadata.tooling.soap.sforce.com"',
        apiName: "Tooling"
      }
    };
    if (apiName) {
      wsdl = wsdl[apiName];
    }
    return wsdl;
  },

  async soap(wsdl, method, args, {headers} = {}) {
    if (!this.instanceHostname || !this.sessionId) {
      throw new Error("Session not found");
    }

    // Track API call start time for statistics
    const startTime = performance.now();

    // Safari: proxy SOAP calls through background to bypass CORS
    if (typeof location !== "undefined" && location.protocol === "safari-web-extension:") {
      const soapUrl = "https://" + this.instanceHostname + wsdl.servicePortAddress + "?cache=" + Math.random();
      console.log("[SF-DBG soap] Safari proxy path. method:", method, "url:", soapUrl);

      let sessionHeaderKey = wsdl.apiName == "Metadata" ? "met:SessionHeader" : "SessionHeader";
      let sessionIdKey = wsdl.apiName == "Metadata" ? "met:sessionId" : "sessionId";
      let requestMethod = wsdl.apiName == "Metadata" ? `met:${method}` : method;
      let requestAttributes = [
        'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema"',
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      ];
      if (wsdl.apiName == "Metadata") {
        requestAttributes.push('xmlns:met="http://soap.sforce.com/2006/04/metadata"');
      }

      let requestBody = XML.stringify({
        name: "soapenv:Envelope",
        attributes: ` ${requestAttributes.join(" ")}${wsdl.targetNamespaces}`,
        value: {
          "soapenv:Header": Object.assign({}, {[sessionHeaderKey]: {[sessionIdKey]: this.sessionId}}, headers),
          "soapenv:Body": {[requestMethod]: args}
        }
      });

      const proxyHeaders = {
        "Content-Type": "text/xml",
        "SOAPAction": '""',
        "CallOptions": `client:${clientId}`
      };

      const r = await new Promise(resolve =>
        chrome.runtime.sendMessage({
          message: "proxyFetch",
          url: soapUrl,
          method: "POST",
          headers: proxyHeaders,
          body: requestBody
        }, resolve));

      const duration = performance.now() - startTime;
      const status = r?.status ?? 0;
      console.log("[SF-DBG soap] response status:", status);

      if (status === 200) {
        apiStatistics.trackApiCall("soap", null, method, duration, false);
        let doc = new DOMParser().parseFromString(r.body, "text/xml");
        let responseBody = doc.querySelector(method + "Response");
        return XML.parse(responseBody).result;
      } else {
        let errorMessage;
        try {
          let doc = new DOMParser().parseFromString(r.body, "text/xml");
          errorMessage = doc.querySelector("faultstring")?.textContent || `HTTP error ${status}`;
        } catch {
          errorMessage = `HTTP error ${status}`;
        }
        console.error("[SF-DBG soap] error:", errorMessage);
        apiStatistics.trackApiCall("soap", null, method, duration, true, errorMessage);
        let err = new Error(errorMessage);
        err.name = "SalesforceSoapError";
        throw err;
      }
    }

    let xhr = new XMLHttpRequest();
    xhr.open("POST", "https://" + this.instanceHostname + wsdl.servicePortAddress + "?cache=" + Math.random(), true);
    xhr.setRequestHeader("Content-Type", "text/xml");
    xhr.setRequestHeader("SOAPAction", '""');
    xhr.setRequestHeader("CallOptions", `client:${clientId}`);

    let sessionHeaderKey = wsdl.apiName == "Metadata" ? "met:SessionHeader" : "SessionHeader";
    let sessionIdKey = wsdl.apiName == "Metadata" ? "met:sessionId" : "sessionId";
    let requestMethod = wsdl.apiName == "Metadata" ? `met:${method}` : method;
    let requestAttributes = [
      'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
      'xmlns:xsd="http://www.w3.org/2001/XMLSchema"',
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    ];
    if (wsdl.apiName == "Metadata") {
      requestAttributes.push('xmlns:met="http://soap.sforce.com/2006/04/metadata"');
    }

    let requestBody = XML.stringify({
      name: "soapenv:Envelope",
      attributes: ` ${requestAttributes.join(" ")}${wsdl.targetNamespaces}`,
      value: {
        "soapenv:Header": Object.assign({}, {[sessionHeaderKey]: {[sessionIdKey]: this.sessionId}}, headers),
        "soapenv:Body": {[requestMethod]: args}
      }
    });

    xhr.responseType = "document";
    await new Promise(resolve => {
      xhr.onreadystatechange = () => {
        if (xhr.readyState == 4) {
          resolve(xhr);
        }
      };
      xhr.send(requestBody);
    });

    // Calculate duration and track statistics
    const duration = performance.now() - startTime;
    let errorMessage = null;

    if (xhr.status == 200) {
      apiStatistics.trackApiCall("soap", null, method, duration, false);
      let responseBody = xhr.response.querySelector(method + "Response");
      let parsed = XML.parse(responseBody).result;
      return parsed;
    } else {
      console.error("Received error response from Salesforce SOAP API", xhr);
      let err = new Error();
      err.name = "SalesforceSoapError";
      err.detail = xhr.response;
      try {
        errorMessage = xhr.response.querySelector("faultstring").textContent;
        err.message = errorMessage;
      } catch (ex) {
        errorMessage = `HTTP error ${xhr.status} ${xhr.statusText}`;
        err.message = errorMessage;
      }
      apiStatistics.trackApiCall("soap", null, method, duration, true, errorMessage);
      throw err;
    }
  },

  asArray(x) {
    if (!x) return [];
    if (x instanceof Array) return x;
    return [x];
  },

};

export class XML {
  static stringify({name, attributes, value}) {
    function buildRequest(el, params) {
      if (params == null) {
        el.setAttribute("xsi:nil", "true");
      } else if (typeof params == "object") {
        for (let [key, value] of Object.entries(params)) {
          if (key == "_") {
            if (value == null) {
              el.setAttribute("xsi:nil", "true");
            } else {
              el.textContent = value;
            }
          } else if (key == "$xsi:type") {
            el.setAttribute("xsi:type", value);
          } else if (value === undefined) {
            // ignore
          } else if (Array.isArray(value)) {
            for (let element of value) {
              let x = doc.createElement(key);
              buildRequest(x, element);
              el.appendChild(x);
            }
          } else {
            let x = doc.createElement(key);
            buildRequest(x, value);
            el.appendChild(x);
          }
        }
      } else {
        el.textContent = params;
      }
    }
    let doc = new DOMParser().parseFromString("<" + name + attributes + "/>", "text/xml");
    buildRequest(doc.documentElement, value);
    return '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(doc).replace(/ xmlns=""/g, "");
  }

  static parse(element) {
    function parseResponse(element) {
      let str = ""; // XSD Simple Type value
      let obj = null; // XSD Complex Type value
      // If the element has child elements, it is a complex type. Otherwise we assume it is a simple type.
      if (element.getAttribute("xsi:nil") == "true") {
        return null;
      }
      let type = element.getAttribute("xsi:type");
      if (type) {
        // Salesforce never sets the xsi:type attribute on simple types. It is only used on sObjects.
        obj = {
          "$xsi:type": type
        };
      }
      for (let child = element.firstChild; child != null; child = child.nextSibling) {
        if (child instanceof CharacterData) {
          str += child.data;
        } else if (child instanceof Element) {
          if (obj == null) {
            obj = {};
          }
          let name = child.localName;
          let content = parseResponse(child);
          if (name in obj) {
            if (obj[name] instanceof Array) {
              obj[name].push(content);
            } else {
              obj[name] = [obj[name], content];
            }
          } else {
            obj[name] = content;
          }
        } else {
          throw new Error("Unknown child node type");
        }
      }
      return obj || str;
    }
    return parseResponse(element);
  }
}

function getMyDomain(host) {
  if (host) {
    const myDomain = host
      .replace(/\.lightning\.force\./, ".my.salesforce.") //avoid HTTP redirect (that would cause Authorization header to be dropped)
      .replace(/\.lightning\.([^.]+)\.force\.com$/, ".my.$1.salesforce.com") // handle hosts like *.lightning.xx-xxx.force.com
      .replace(/\.mcas\.ms$/, ""); //remove trailing .mcas.ms if the client uses Microsoft Defender for Cloud Apps
    return myDomain;
  }
  return host;
}

function showToastBanner(){
  const containerToShow = document.getElementById("toastBanner");
  if (containerToShow) { containerToShow.classList.remove("hide"); }
  const containerToMask = document.getElementById("mainTabs");
  if (containerToMask) { containerToMask.classList.add("mask"); }
}
