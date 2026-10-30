// AI-powered SOQL query generator
// Two-pass flow: LLM picks the most likely SObject from describeGlobal, then writes SOQL using that SObject's fields.

import {sfConn, apiVersion} from "./inspector.js";

export const AI_PROVIDERS = {
  claude: {
    name: "Claude (Anthropic)",
    defaultModel: "claude-haiku-4-5-20251001",
    suggestedModels: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-7"],
    keyPlaceholder: "sk-ant-…",
    async chat({messages, model, apiKey, system}) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system,
          messages: messages.map(m => ({role: m.role, content: m.content}))
        })
      });
      if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    }
  },
  openai: {
    name: "OpenAI (ChatGPT)",
    defaultModel: "gpt-4o-mini",
    suggestedModels: ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"],
    keyPlaceholder: "sk-…",
    async chat({messages, model, apiKey, system}) {
      const fullMessages = system ? [{role: "system", content: system}, ...messages] : messages;
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({model, messages: fullMessages, temperature: 0})
      });
      if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    }
  },
  gemini: {
    name: "Google Gemini",
    defaultModel: "gemini-2.0-flash",
    suggestedModels: ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"],
    keyPlaceholder: "AIza…",
    async chat({messages, model, apiKey, system}) {
      const contents = messages.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{text: m.content}]
      }));
      const body = {contents};
      if (system) body.systemInstruction = {parts: [{text: system}]};
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      return parts.map(p => p.text || "").join("");
    }
  },
  deepseek: {
    name: "DeepSeek",
    defaultModel: "deepseek-chat",
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
    keyPlaceholder: "sk-…",
    async chat({messages, model, apiKey, system}) {
      const fullMessages = system ? [{role: "system", content: system}, ...messages] : messages;
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({model, messages: fullMessages, temperature: 0})
      });
      if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    }
  }
};

function extractJson(text) {
  if (!text) return null;
  // Strip code fences if the model wrapped JSON in ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function extractSOQL(text) {
  if (!text) return "";
  const fenced = text.match(/```(?:soql|sql)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : text).trim();
  // Drop trailing semicolon and surrounding whitespace
  return raw.replace(/;\s*$/, "").trim();
}

async function fetchGlobalDescribe(useToolingApi) {
  const path = "/services/data/v" + apiVersion + "/" + (useToolingApi ? "tooling/" : "") + "sobjects";
  const res = await sfConn.rest(path);
  return res.sobjects || [];
}

async function fetchSobjectDescribe(sobjectName, useToolingApi) {
  const path = "/services/data/v" + apiVersion + "/" + (useToolingApi ? "tooling/" : "") + "sobjects/" + encodeURIComponent(sobjectName) + "/describe";
  return await sfConn.rest(path);
}

function tokenizePrompt(prompt) {
  return (prompt.toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter(t => !["the", "and", "where", "with", "from", "select", "find", "all", "for", "are", "that", "this", "have", "has", "like", "any", "but", "not", "you", "your"].includes(t));
}

function rankSObject(so, tokens) {
  // Higher score = more relevant. Tokens matching label or name boost rank.
  const name = (so.name || "").toLowerCase();
  const label = (so.label || "").toLowerCase();
  const labelPlural = (so.labelPlural || "").toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (name.includes(t)) score += 3;
    if (label.includes(t)) score += 5;
    if (labelPlural.includes(t)) score += 5;
  }
  return score;
}

function summarizeSObjectList(sobjects, userPrompt) {
  // Build list with prompt-keyword-relevant objects first, then everything else, truncated at ~60KB to stay safe in LLM context windows.
  const MAX_CHARS = 60000;
  const queryable = sobjects.filter(s => s.queryable);
  const tokens = tokenizePrompt(userPrompt);
  const scored = queryable.map(s => ({so: s, score: rankSObject(s, tokens)}));
  // Sort: matches first (desc score), then alpha by name.
  scored.sort((a, b) => (b.score - a.score) || a.so.name.localeCompare(b.so.name));
  let out = "";
  let included = 0;
  let total = scored.length;
  for (const {so} of scored) {
    const label = so.label || so.name;
    const plural = so.labelPlural && so.labelPlural !== label ? ` (plural: ${so.labelPlural})` : "";
    const line = `${so.name} -- ${label}${plural}\n`;
    if (out.length + line.length > MAX_CHARS) break;
    out += line;
    included++;
  }
  if (included < total) out += `(${total - included} more objects omitted to fit context)\n`;
  return out;
}

function findSObjectMatch(sobjects, candidateName) {
  if (!candidateName) return null;
  const queryable = sobjects.filter(s => s.queryable);
  const lower = candidateName.toLowerCase();
  // Exact (case-sensitive)
  let m = queryable.find(s => s.name === candidateName);
  if (m) return m.name;
  // Exact (case-insensitive)
  m = queryable.find(s => s.name.toLowerCase() === lower);
  if (m) return m.name;
  // Strip leading namespace from candidate, compare to suffix
  const stripped = lower.replace(/^[a-z0-9]+__/, "");
  m = queryable.find(s => s.name.toLowerCase().replace(/^[a-z0-9]+__/, "") === stripped);
  if (m) return m.name;
  // Substring: candidate is contained in an actual name (e.g. "Account" in "npsp__Account__c")
  m = queryable.find(s => s.name.toLowerCase().includes(lower) || s.name.toLowerCase().endsWith("__" + lower));
  if (m) return m.name;
  // Label match
  m = queryable.find(s => (s.label || "").toLowerCase() === lower || (s.labelPlural || "").toLowerCase() === lower);
  if (m) return m.name;
  return null;
}

function summarizeFields(describe) {
  const fields = describe.fields || [];
  return fields
    .map(f => `${f.name} : ${f.type}${f.label && f.label !== f.name ? ` (${f.label})` : ""}${f.referenceTo?.length ? ` -> ${f.referenceTo.join("|")}` : ""}`)
    .join("\n");
}

async function pickCandidates({prompt, sobjects, provider, resolvedModel, apiKey}) {
  const sobjectListText = summarizeSObjectList(sobjects, prompt);
  const pickSystem = "You are an expert Salesforce SOQL writer. The user describes data they want, and you identify the most likely target SObject from the org's catalog.\n\nDecision rules:\n- If exactly one object obviously fits, return one candidate.\n- If multiple objects could plausibly fit (e.g. namespace variants, similar names, or ambiguous user phrasing), return up to 4 candidates ordered by likelihood.\n- Do NOT include candidates you are confident are wrong.\n- ALWAYS use the EXACT API name from the list, including any namespace prefix (e.g. \"npsp__General_Accounting_Unit__c\").\n\nRespond with ONLY this JSON shape:\n{\"candidates\": [{\"sobjectName\": \"<exact api name>\", \"reason\": \"<one short sentence>\"}]}\n\nNever include any other text or commentary.";
  const pickUser = `User request: ${prompt}\n\nAvailable SObjects (exact API name -- Label):\n${sobjectListText}\n\nReturn JSON only.`;
  const pickResponse = await provider.chat({
    messages: [{role: "user", content: pickUser}],
    model: resolvedModel,
    apiKey,
    system: pickSystem
  });
  const pickJson = extractJson(pickResponse);
  let candidates = Array.isArray(pickJson?.candidates) ? pickJson.candidates : null;
  // Back-compat: if the model returned the old shape {sobjectName: "..."}, wrap it.
  if (!candidates && pickJson?.sobjectName) candidates = [{sobjectName: pickJson.sobjectName, reason: ""}];
  if (!candidates || candidates.length === 0) throw new Error(`Could not parse candidates from AI response: ${pickResponse.slice(0, 300)}`);
  // Validate each candidate against the catalog; drop unresolvable ones, de-dupe, cap at 4.
  const seen = new Set();
  const resolved = [];
  for (const c of candidates) {
    if (!c || typeof c.sobjectName !== "string") continue;
    const matched = findSObjectMatch(sobjects, c.sobjectName);
    if (!matched || seen.has(matched)) continue;
    seen.add(matched);
    const sob = sobjects.find(s => s.name === matched);
    resolved.push({sobjectName: matched, label: sob?.label || matched, reason: (c.reason || "").trim()});
    if (resolved.length >= 4) break;
  }
  if (resolved.length === 0) throw new Error(`AI returned candidates but none matched any SObject in this org. Raw: ${pickResponse.slice(0, 300)}`);
  return resolved;
}

async function writeSOQL({prompt, sobjectName, provider, resolvedModel, apiKey, useToolingApi, onProgress}) {
  onProgress?.(`Loading ${sobjectName} fields…`);
  let describe;
  try {
    describe = await fetchSobjectDescribe(sobjectName, useToolingApi);
  } catch (e) {
    throw new Error(`SObject "${sobjectName}" does not exist or isn't accessible: ${e.message || e}`);
  }
  const fieldsText = summarizeFields(describe);
  onProgress?.("Asking AI to write SOQL…");
  const writeSystem = "You are an expert Salesforce SOQL writer. Given a user request and the available fields on a target SObject, write a single valid SOQL query. Use only fields from the provided list. Respond with ONLY the SOQL query — no markdown fences, no commentary, no semicolon. Include a LIMIT 200 clause when none is implied by the request.";
  const writeUser = `User request: ${prompt}\n\nTarget SObject: ${sobjectName}\n\nAvailable fields (api name : type [(label)] [-> reference target]):\n${fieldsText}\n\nReturn only the SOQL.`;
  const writeResponse = await provider.chat({
    messages: [{role: "user", content: writeUser}],
    model: resolvedModel,
    apiKey,
    system: writeSystem
  });
  const soql = extractSOQL(writeResponse);
  if (!soql) throw new Error(`AI returned empty SOQL. Raw: ${writeResponse.slice(0, 300)}`);
  return soql;
}

export async function generateAISOQL({prompt, providerId, apiKey, model, useToolingApi = false, onProgress}) {
  const provider = AI_PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  if (!apiKey) throw new Error("Missing API key. Set one in Options.");
  if (!prompt || !prompt.trim()) throw new Error("Empty prompt.");
  const resolvedModel = model || provider.defaultModel;

  onProgress?.("Loading object catalog…");
  const sobjects = await fetchGlobalDescribe(useToolingApi);

  onProgress?.("Asking AI to identify the target SObject…");
  const candidates = await pickCandidates({prompt, sobjects, provider, resolvedModel, apiKey});

  if (candidates.length === 1) {
    const sobjectName = candidates[0].sobjectName;
    const soql = await writeSOQL({prompt, sobjectName, provider, resolvedModel, apiKey, useToolingApi, onProgress});
    return {soql, sobjectName, model: resolvedModel, provider: providerId};
  }
  return {needsChoice: true, candidates, model: resolvedModel, provider: providerId};
}

export async function writeAISOQLForObject({prompt, sobjectName, providerId, apiKey, model, useToolingApi = false, onProgress}) {
  const provider = AI_PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  if (!apiKey) throw new Error("Missing API key. Set one in Options.");
  if (!sobjectName) throw new Error("Missing sobjectName.");
  const resolvedModel = model || provider.defaultModel;
  const soql = await writeSOQL({prompt, sobjectName, provider, resolvedModel, apiKey, useToolingApi, onProgress});
  return {soql, sobjectName, model: resolvedModel, provider: providerId};
}
