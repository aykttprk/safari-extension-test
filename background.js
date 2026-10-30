
// Keep service worker alive so it appears in Safari's Web Extension Background Content menu
chrome.alarms?.create?.("keepalive", {periodInMinutes: 0.5});
chrome.alarms?.onAlarm?.addListener?.(() => {});

let sfHost;

// Safari: sender.tab.cookieStoreId is not populated for extension-iframe senders.
// Look up the right store by matching the sender tab's id against getAllCookieStores().
function resolveStoreId(sender, callback) {
  const fromSender = sender?.tab?.cookieStoreId;
  if (fromSender) return callback(fromSender);
  const tabId = sender?.tab?.id;
  if (tabId == null || !chrome.cookies?.getAllCookieStores) return callback(undefined);
  chrome.cookies.getAllCookieStores(stores => {
    const match = (stores || []).find(s => s.tabIds?.includes(tabId));
    callback(match?.id);
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Diagnostic: run every cookie probe in the background context and return everything.
  if (request.message == "diagStores") {
    const result = {senderTab: {url: sender.tab?.url, cookieStoreId: sender.tab?.cookieStoreId, windowId: sender.tab?.windowId}, stores: null, perStore: {}, totalCookies: null, sampleDomains: null};
    chrome.cookies.getAllCookieStores(stores => {
      result.stores = stores;
      let storesToTest = (stores && stores.length) ? stores.map(s => s.id) : [undefined, "0", "firefox-default"];
      let pending = storesToTest.length + 1;
      const done = () => { if (--pending === 0) sendResponse(result); };
      chrome.cookies.getAll({}, all => {
        result.totalCookies = all?.length || 0;
        const domains = {};
        (all || []).forEach(c => { domains[c.domain] = (domains[c.domain] || 0) + 1; });
        result.sampleDomains = Object.entries(domains).slice(0, 30);
        done();
      });
      storesToTest.forEach(sid => {
        chrome.cookies.getAll({domain: "salesforce.com", storeId: sid}, cs => {
          result.perStore[String(sid)] = {count: cs?.length || 0, sample: (cs || []).slice(0, 3).map(c => ({name: c.name, domain: c.domain}))};
          done();
        });
      });
    });
    return true;
  }
  if (request.message == "diagCookies") {
    const storeId = sender.tab?.cookieStoreId;
    const host = request.host || "ijm--fulltest.sandbox.my.salesforce.com";
    const lightningHost = host.replace(".my.salesforce.com", ".lightning.force.com");
    const result = {storeId, host, lightningHost, tests: {}};
    const finish = () => sendResponse(result);
    let pending = 6;
    const done = () => { if (--pending === 0) finish(); };

    try {
      chrome.cookies.get({url: "https://" + host, name: "sid", storeId}, c => {
        result.tests.getMyDomain_sid = c ? {found: true, domain: c.domain, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, len: c.value?.length} : {found: false, lastError: chrome.runtime.lastError?.message || null};
        done();
      });
    } catch (e) { result.tests.getMyDomain_sid = {threw: e.message}; done(); }

    try {
      chrome.cookies.get({url: "https://" + lightningHost, name: "sid", storeId}, c => {
        result.tests.getLightning_sid = c ? {found: true, domain: c.domain, httpOnly: c.httpOnly, secure: c.secure, len: c.value?.length} : {found: false, lastError: chrome.runtime.lastError?.message || null};
        done();
      });
    } catch (e) { result.tests.getLightning_sid = {threw: e.message}; done(); }

    try {
      chrome.cookies.getAll({name: "sid", storeId}, cs => {
        result.tests.getAll_sid = {count: cs?.length || 0, cookies: (cs || []).map(c => ({domain: c.domain, httpOnly: c.httpOnly, secure: c.secure, len: c.value?.length})), lastError: chrome.runtime.lastError?.message || null};
        done();
      });
    } catch (e) { result.tests.getAll_sid = {threw: e.message}; done(); }

    try {
      chrome.cookies.getAll({domain: "salesforce.com", storeId}, cs => {
        result.tests.getAll_salesforce = {count: cs?.length || 0, sample: (cs || []).slice(0, 5).map(c => ({name: c.name, domain: c.domain, httpOnly: c.httpOnly})), lastError: chrome.runtime.lastError?.message || null};
        done();
      });
    } catch (e) { result.tests.getAll_salesforce = {threw: e.message}; done(); }

    try {
      chrome.cookies.getAll({url: "https://" + host, storeId}, cs => {
        result.tests.getAll_byUrl = {count: cs?.length || 0, names: (cs || []).map(c => c.name).join(","), lastError: chrome.runtime.lastError?.message || null};
        done();
      });
    } catch (e) { result.tests.getAll_byUrl = {threw: e.message}; done(); }

    try {
      chrome.permissions?.contains?.({permissions: ["cookies"], origins: ["https://" + host + "/*"]}, has => {
        result.tests.permsContains = {hasCookiesAndOrigin: has, lastError: chrome.runtime.lastError?.message || null};
        done();
      });
    } catch (e) { result.tests.permsContains = {threw: e.message}; done(); }

    return true;
  }

  // Perform cookie operations in the background page, because not all foreground pages have access to the cookie API.
  // Firefox does not support incognito split mode, so we use sender.tab.cookieStoreId to select the right cookie store.
  // Chrome does not support sender.tab.cookieStoreId, which means it is undefined, and we end up using the default cookie store according to incognito split mode.

  // Safari combined handler: get both sfHost AND session in one call using the page URL.
  // This avoids the issue where getSession constructs a URL from the sfHost hostname
  // that doesn't match any cookie (due to leading dots or domain mismatches).
  if (request.message == "getHostAndSession") {
    resolveStoreId(sender, storeId => {
    console.log("[SF-DBG getHostAndSession] url:", request.url, "storeId:", storeId);
    chrome.cookies.get({url: request.url, name: "sid", storeId}, cookie => {
      if (!cookie) {
        console.log("[SF-DBG getHostAndSession] No sid cookie at page URL");
        sendResponse({sfHost: new URL(request.url).hostname, session: null});
        return;
      }
      console.log("[SF-DBG getHostAndSession] Found sid at page URL. domain:", cookie.domain, "value (first 15):", cookie.value.substring(0, 15) + "...");
      const [orgId] = cookie.value.split("!");
      const orderedDomains = ["salesforce.com", "cloudforce.com", "salesforce.mil", "cloudforce.mil", "sfcrmproducts.cn", "force.com"];
      let responded = false;

      orderedDomains.forEach(domain => {
        chrome.cookies.getAll({name: "sid", domain, secure: true, storeId}, cookies => {
          if (responded) return;
          let sessionCookie = cookies.find(c => c.value.startsWith(orgId + "!") && c.domain != "help.salesforce.com");
          if (sessionCookie) {
            responded = true;
            console.log("[SF-DBG getHostAndSession] API session found. domain:", sessionCookie.domain, "value (first 15):", sessionCookie.value.substring(0, 15) + "...");
            sendResponse({
              sfHost: sessionCookie.domain,
              session: {key: sessionCookie.value, hostname: sessionCookie.domain}
            });
          }
        });
      });
    });
    });
    return true;
  }

  if (request.message == "getSfHost") {
    const currentDomain = new URL(request.url).hostname;
    resolveStoreId(sender, storeId => {
    chrome.cookies.get({url: request.url, name: "sid", storeId}, cookie => {
      if (!cookie || currentDomain.endsWith(".mcas.ms")) {
        sendResponse(currentDomain);
        return;
      }
      const [orgId] = cookie.value.split("!");
      const orderedDomains = ["salesforce.com", "cloudforce.com", "salesforce.mil", "cloudforce.mil", "sfcrmproducts.cn", "force.com"];

      orderedDomains.forEach(currentDomain => {
        chrome.cookies.getAll({name: "sid", domain: currentDomain, secure: true, storeId}, cookies => {
          let sessionCookie = cookies.find(c => c.value.startsWith(orgId + "!") && c.domain != "help.salesforce.com");
          if (sessionCookie) {
            sendResponse(sessionCookie.domain);
          }
        });
      });
    });
    });
    return true;
  }
  if (request.message == "getSession") {
    sfHost = request.sfHost;
    const cleanHost = sfHost.replace(/^\./, "");
    console.log("[SF-DBG getSession] sfHost:", request.sfHost, "cleanHost:", cleanHost);
    resolveStoreId(sender, storeId => {
    console.log("[SF-DBG getSession] resolved storeId:", storeId);
    chrome.cookies.get({url: "https://" + cleanHost, name: "sid", storeId}, sessionCookie => {
      if (!sessionCookie) {
        console.warn("[SF-DBG getSession] No sid cookie found for", cleanHost);
        sendResponse(null);
        return;
      }
      console.log("[SF-DBG getSession] sid cookie found. domain:", sessionCookie.domain, "value (first 20):", sessionCookie.value.substring(0, 20) + "...");
      let session = {key: sessionCookie.value, hostname: sessionCookie.domain};
      sendResponse(session);
    });
    });
    return true;
  } else if (request.message == "proxyFetch") {
    const {url, method, headers, body} = request;
    console.log("[SF-DBG proxyFetch] →", method || "GET", url);
    console.log("[SF-DBG proxyFetch] headers:", JSON.stringify(headers));
    fetch(url, {method: method || "GET", headers: headers || {}, body: body || undefined, credentials: "include"})
      .then(async res => {
        const text = await res.text();
        console.log("[SF-DBG proxyFetch] ←", res.status, text.substring(0, 300));
        sendResponse({status: res.status, body: text});
      })
      .catch(err => {
        console.error("[SF-DBG proxyFetch] fetch error:", err);
        sendResponse({status: 0, body: ""});
      });
    return true;
  } else if (request.message == "createWindow") {
    const brow = typeof browser === "undefined" ? chrome : browser;
    brow.windows.create({
      url: request.url,
      incognito: request.incognito ?? false
    });
  } else if (request.message == "reloadPage") {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      chrome.tabs.reload(tabs[0].id);
    });
  }
  return false;
});
chrome.action?.onClicked?.addListener(() => {
  chrome.runtime.sendMessage({
    msg: "shortcut_pressed", sfHost, command: "open-popup"
  });
});
chrome.commands?.onCommand.addListener((command) => {
  if (command.startsWith("link-")){
    let link;
    switch (command){
      case "link-setup":
        link = "/lightning/setup/SetupOneHome/home";
        break;
      case "link-home":
        link = "/";
        break;
      case "link-dev":
        link = "/_ui/common/apex/debug/ApexCSIPage";
        break;
    }
    chrome.tabs.create({
      url: `https://${sfHost}${link}`
    });

  } else if (command.startsWith("open-")){
    chrome.runtime.sendMessage({
      msg: "shortcut_pressed", command, sfHost
    });
  } else {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`${command}.html?host=${sfHost}`)
    });
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    chrome.tabs.create({
      url: "https://tprouvot.github.io/Salesforce-Inspector-reloaded/welcome/"
    });
  } else if (details.reason === "update" && details.previousVersion?.startsWith("2.0")) {
    //TODO delete clearSobjectsListCache after 2.0.1 release, only for upgrade from 2.0.0 to 2.0.1
    await clearSobjectsListCache();
  }
});

async function clearSobjectsListCache() {
  try {
    const storage = (typeof chrome !== "undefined" && chrome.storage) ? chrome.storage : browser.storage;
    if (!storage?.local) return;
    const allData = await storage.local.get(null);
    const keysToRemove = Object.keys(allData || {}).filter(key =>
      key === "cache_sobjectsList"
    );
    if (keysToRemove.length > 0) {
      await storage.local.remove(keysToRemove);
    }
  } catch (e) {
    console.error("Error clearing sobjectsList cache on update:", e);
  }
}
chrome.runtime.setUninstallURL?.("https://forms.gle/y7LbTNsFqEqSrtyc6");
