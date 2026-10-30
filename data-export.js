/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {getLinkTarget, nullToEmptyString, isOptionEnabled, PromptTemplate, Constants, UserInfoModel, createSpinForMethod, copyToClipboard, downloadCsvFile, StorageHistory} from "./utils.js";
/* global initButton */
import {Enumerable, DescribeInfo, initScrollTable, s} from "./data-load.js";
import {PageHeader} from "./components/PageHeader.js";
import {Editor} from "./editor.js";
import {AI_PROVIDERS, generateAISOQL, writeAISOQLForObject} from "./ai-soql.js";

function createQueryHistory(storageKey, max) {
  const isSaved = storageKey === "insextSavedQueryHistory";
  return new StorageHistory(storageKey, max, {
    isValidEntry: (e) => typeof e === "object",
    matchAdd: (e, ent) => e.query === ent.query && e.useToolingApi === ent.useToolingApi,
    matchRemove: (e, ent) => e.query === ent.query && e.useToolingApi === ent.useToolingApi,
    sortComparator: isSaved ? (a, b) => (a.query > b.query ? 1 : b.query > a.query ? -1 : 0) : null,
    addToFront: true
  });
}

class Model {
  static QUERY_TAB_PREFIX = "Query";

  constructor({sfHost, args}) {
    this.sfHost = sfHost;
    this.customFaviconColor = localStorage.getItem(this.sfHost + "_customFavicon") || "";
    this.orgName = this.sfHost.split(".")[0]?.toUpperCase() || "";
    this.queryInput = null;
    this.editor = null;
    this.editorMirror = null;
    this.autocompleteResultBox = null;
    this.displaySuggestion = false;
    this.activeSuggestion = -1;
    this.historyStack = [];
    this.historyOffset = -1;
    this.suggestionTop = 0;
    this.suggestionLeft = 0;
    this.filterColumn = ""; // Default filter column
    this.initialQuery = "";
    this.spinnerCount = 0;

    // Initialize spinFor method early - needed by describeInfo and userInfoModel
    this.spinFor = createSpinForMethod(this);

    this.describeInfo = new DescribeInfo(this.spinFor.bind(this), () => {
      this.queryAutocompleteHandler({newDescribe: true});
      this.didUpdate();
    });
    this.sfLink = "https://" + sfHost;
    this.showHelp = false;
    this.winInnerHeight = 0;
    this.queryAll = false;
    this.queryTooling = false;
    this.prefHideRelations = localStorage.getItem("hideObjectNameColumnsDataExport") == "true"; // default to false
    this.prefPreventLineWrap = localStorage.getItem("preventLineWrapDataExport") !== "false"; // default to true (matches v1.27 behavior)
    this.autocompleteResults = {sobjectName: "", title: "\u00A0", results: []};
    this.isWorking = false;
    this.exportStatus = "Ready";
    this.exportError = null;
    this.exportedData = null;
    let historyNb = localStorage.getItem("numberOfQueriesInHistory");
    this.queryHistory = createQueryHistory("insextQueryHistory", historyNb ? historyNb : 100);
    this.selectedHistoryEntry = null;
    let savedNb = localStorage.getItem("numberOfQueriesSaved");
    this.savedHistory = createQueryHistory("insextSavedQueryHistory", savedNb ? savedNb : 50);
    this.selectedSavedEntry = null;
    this.expandAutocomplete = false;
    this.expandSavedOptions = false;
    this.resultsFilter = "";
    this.displayPerformance = localStorage.getItem("displayQueryPerformance") !== "false"; // default to true
    this.performancePoints = [];
    this.startTime = null;
    this.lastStartTime = null;
    this.totalTime = 0;
    this.autocompleteState = "";
    this.autocompleteProgress = {};
    this.exportProgress = {};
    this.queryName = "";
    this.queryTemplates = localStorage.getItem("queryTemplates") ? this.queryTemplates = localStorage.getItem("queryTemplates").split("//") : [
      "SELECT Id FROM ",
      'FIND {""}\nIN Name Fields\nRETURNING Contact(Name, Phone)',
      "{\n\tuiapi {\n\t\tquery {\n\t\t\tContact {\n\t\t\t\tedges {\n\t\t\t\t\t node {\n\t\t\t\t\t\tId\n\t\t\t\t\t\tName { value }\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}",
      "SELECT Id FROM WHERE",
      "SELECT Id FROM WHERE IN",
      "SELECT Id FROM WHERE LIKE",
      "SELECT Id FROM WHERE ORDER BY"
    ];
    this.separator = getSeparator();
    this.soqlPrompt = "";
    this.enableQueryTypoFix = localStorage.getItem("enableQueryTypoFix") == "true";

    // Initialize user info model - handles all user-related properties
    this.userInfoModel = new UserInfoModel(this.spinFor.bind(this));

    let queryFromUrl = false;
    if (args.has("query")) {
      this.initialQuery = args.get("query");
      this.queryTooling = args.has("useToolingApi");
      queryFromUrl = true;
    } else if (this.queryHistory.list[0]) {
      this.initialQuery = this.queryHistory.list[0].query;
      this.queryTooling = this.queryHistory.list[0].useToolingApi;
    } else {
      this.initialQuery = "SELECT Id FROM Account LIMIT 200";
      this.queryTooling = false;
    }

    if (args.has("error")) {
      this.exportError = args.get("error") + " " + args.get("error_description");
    }

    this.queryTabs = [];
    this.activeTabIndex = 0;
    this.loadQueryTabs(queryFromUrl);
  }

  updatedExportedData() {
    if (this.exportedData) {
      this.exportedData.updateColumnsVisibility();
    }
    this.resultTableCallback(this.exportedData);
  }
  setResultsFilter(value) {
    this.resultsFilter = value;
    if (this.exportedData == null) {
      return;
    }
    // Recalculate visibility
    this.exportedData.updateVisibility();
    this.updatedExportedData();
  }
  setQueryMethod(data, query, vm){
    let method;
    let queryParams = "/?q=" + encodeURIComponent(query);
    const baseParams = {progressHandler: vm.exportProgress};
    let params = baseParams;

    if (data.isTooling){
      method = "tooling/query";
    } else if (this.queryAll){
      method = "queryAll";
    } else if (this.queryInput.value.toLowerCase().startsWith("find")){
      method = "search";
    } else if (this.queryInput.value.trim().startsWith("{")){
      method = "graphql";
      queryParams = "";
      params = {...baseParams, method: "POST", body: {"query": "query objects " + query}};
    } else {
      method = "query";
    }
    data.endpoint = "/services/data/v" + apiVersion + "/" + method + queryParams;
    data.params = params;
    data.queryMethod = method;
  }
  setQueryName(value) {
    this.queryName = value;
  }
  setQueryInput(queryInput) {
    this.queryInput = queryInput;
    queryInput.value = this.initialQuery;
    this.initialQuery = null;
  }
  setEditor(editor) {
    this.editor = editor;
    this.queryInput = editor; // alias so existing code paths keep working
    editor.value = this.initialQuery != null ? this.initialQuery : editor.value;
    this.historyStack = [{
      value: editor.value,
      selectionStart: 0,
      selectionEnd: 0,
      timestamp: Date.now()
    }];
    this.historyOffset = 0;
    this.initialQuery = null;
  }
  editorAutocompleteHandler(e = {}) {
    return this.queryAutocompleteHandler(e);
  }
  applyEdit(value, selectionStart, selectionEnd, mode = "preserve") {
    if (this.editor) {
      this.editor.setRangeText(value, selectionStart, selectionEnd, mode);
      this.writeEditHistory(this.editor.value, this.editor.selectionStart, this.editor.selectionEnd, true);
    }
  }
  writeEditHistory(value, selectionStart, selectionEnd, force) {
    const HISTORY_LIMIT = 100;
    const HISTORY_TIME_GAP = 3000;
    if (this.historyOffset != -1 && this.historyOffset < this.historyStack.length - 1) {
      this.historyStack = this.historyStack.slice(0, this.historyOffset + 1);
    }
    if (this.historyStack.length > 0 && this.historyOffset > -1 && this.historyStack.length > HISTORY_LIMIT) {
      let cnt = this.historyStack.length - HISTORY_LIMIT;
      this.historyStack = this.historyStack.slice(cnt);
      this.historyOffset = Math.max(this.historyOffset - cnt, 0);
    }
    if (!force && this.historyOffset >= 0) {
      let last = this.historyStack[this.historyOffset];
      let lastWord = last.value.substring(0, last.selectionStart).match(/[a-z0-9]+$/i);
      let newLastWord = value.substring(0, selectionStart).match(/[a-z0-9]+$/i);
      if (last && Date.now() - last.timestamp < HISTORY_TIME_GAP && lastWord && newLastWord && newLastWord[0].startsWith(lastWord[0])) {
        this.historyStack[this.historyOffset] = {value, selectionStart, selectionEnd, timestamp: last.timestamp};
        return;
      }
    }
    this.historyOffset++;
    this.historyStack.push({value, selectionStart, selectionEnd, timestamp: Date.now()});
  }
  handleEditorChange(value, selectionStart, selectionEnd) {
    this.writeEditHistory(value, selectionStart, selectionEnd, false);
    if (typeof this.updateCurrentTabQuery === "function") {
      this.updateCurrentTabQuery(value);
    }
    this.queryAutocompleteHandler();
    this.didUpdate();
  }
  undoEdit() {
    if (this.editor && this.historyOffset > 0) {
      this.historyOffset--;
      let previous = this.historyStack[this.historyOffset];
      this.editor.value = previous.value;
      this.editor.selectionStart = previous.selectionStart;
      this.editor.selectionEnd = previous.selectionEnd;
    }
  }
  redoEdit() {
    if (this.editor && this.historyOffset < this.historyStack.length - 1) {
      this.historyOffset++;
      let next = this.historyStack[this.historyOffset];
      this.editor.value = next.value;
      this.editor.selectionStart = next.selectionStart;
      this.editor.selectionEnd = next.selectionEnd;
    }
  }
  showSuggestion() {
    this.displaySuggestion = true;
    this.editorAutocompleteHandler({newDescribe: true});
    this.didUpdate();
  }
  hideSuggestion() {
    this.displaySuggestion = false;
    this.didUpdate();
  }
  nextSuggestion() {
    if (!this.autocompleteResults || this.autocompleteResults.results.length == 0) {
      return false;
    }
    if (this.activeSuggestion < this.autocompleteResults.results.length - 1) {
      this.activeSuggestion++;
    } else {
      this.activeSuggestion = 0;
    }
    if (this.autocompleteResultBox) {
      let scrolltop = (this.activeSuggestion * 22) - 100;
      this.autocompleteResultBox.scrollTop = scrolltop > 0 ? scrolltop : 0;
    }
    this.didUpdate();
    return true;
  }
  previousSuggestion() {
    if (!this.autocompleteResults || this.autocompleteResults.results.length == 0) {
      return false;
    }
    if (this.activeSuggestion > 0) {
      this.activeSuggestion--;
    } else {
      this.activeSuggestion = this.autocompleteResults.results.length - 1;
    }
    if (this.autocompleteResultBox) {
      let scrolltop = (this.activeSuggestion * 22) - 100;
      this.autocompleteResultBox.scrollTop = scrolltop > 0 ? scrolltop : 0;
    }
    this.didUpdate();
    return true;
  }
  selectSuggestion() {
    if (!this.autocompleteResults || !this.autocompleteResults.results || this.autocompleteResults.results.length == 0) {
      this.editorAutocompleteHandler({ctrlSpace: true});
      return;
    }
    if (!this.editor) return;
    let selStart = this.editor.selectionStart;
    let selEnd = this.editor.selectionEnd;
    let searchTerm;
    if (selStart != selEnd) {
      searchTerm = this.editor.value.substring(selStart, selEnd);
    } else if (this.autocompleteResults.isFieldValue) {
      searchTerm = this.editor.value.substring(0, selEnd).match(/[^,=<>(\s']*$/i)[0];
      selStart -= searchTerm.length;
      if (this.editor.value.substring(0, selStart).endsWith("'")) {
        searchTerm = "'" + searchTerm;
        selStart--;
      }
      if (selEnd < this.editor.value.length && this.editor.value.charAt(selEnd) == "'") {
        searchTerm = searchTerm + "'";
        selEnd++;
      }
    } else {
      searchTerm = this.editor.value.substring(0, selStart).match(/[a-zA-Z0-9_.]*$/)[0];
    }
    selStart = selEnd - searchTerm.length;
    let ar = this.autocompleteResults.results;
    if (this.autocompleteResults.isField && this.activeSuggestion == -1) {
      ar = ar
        .filter(r => r.autocompleteType == "fieldName")
        .map((r, i, l) => (this.autocompleteResults.contextPath || "") + r.value + (i != l.length - 1 ? r.suffix : ""));
      if (ar.length > 0) {
        this.editor.focus();
        this.applyEdit(ar.join(""), selStart, selEnd, "end");
      }
      return;
    }
    if (this.autocompleteResults.isFieldValue && this.activeSuggestion == -1) {
      this.suggestFieldValues();
      return;
    }
    let idx = this.activeSuggestion > -1 ? this.activeSuggestion : 0;
    this.editor.focus();
    this.applyEdit((this.autocompleteResults.contextPath ? this.autocompleteResults.contextPath : "") + ar[idx].value + ar[idx].suffix, selStart, selEnd, "end");
    if (ar[idx].value.startsWith("FIELDS") && !this.editor.value.toLowerCase().includes("limit")) {
      this.editor.value += " LIMIT 200";
    }
    this.activeSuggestion = -1;
    this.editorAutocompleteHandler();
  }
  autocompleteClick(suggestion, suggestionIndex) {
    if (suggestion && suggestion.reload) {
      this.autocompleteReload();
    } else if (suggestion && suggestion.link) {
      window.open(suggestion.link, "_blank");
    } else {
      this.activeSuggestion = suggestionIndex;
      this.selectSuggestion();
    }
  }
  setSuggestionPosition(top, left) {
    if (this.suggestionTop == top && this.suggestionLeft == left) {
      return;
    }
    this.suggestionTop = top;
    this.suggestionLeft = left;
    this.didUpdate();
  }
  recalculateSize() {
    // Editor.js invokes this on textarea resize; trigger a re-render so the App's componentDidUpdate fires its own recalculateSize (scroll table viewport).
    this.didUpdate();
  }
  toggleHelp() {
    this.showHelp = !this.showHelp;
  }
  toggleAI() {
    this.showAI = !this.showAI;
  }
  toggleExpand() {
    this.expandAutocomplete = !this.expandAutocomplete;
  }
  toggleSavedOptions() {
    this.expandSavedOptions = !this.expandSavedOptions;
  }
  showDescribeUrl() {
    let args = new URLSearchParams();
    args.set("host", this.sfHost);
    args.set("objectType", this.autocompleteResults.sobjectName);
    if (this.queryTooling) {
      args.set("useToolingApi", "1");
    }
    return "inspect.html?" + args;
  }
  selectHistoryEntry() {
    if (this.selectedHistoryEntry != null) {
      this.queryInput.value = this.selectedHistoryEntry.query;
      this.queryTooling = this.selectedHistoryEntry.useToolingApi;
      this.queryAutocompleteHandler();
      this.selectedHistoryEntry = null;
    }
  }
  selectQueryTemplate() {
    this.queryInput.value = this.selectedQueryTemplate.trimStart();
    this.queryInput.focus();
    let indexPos = this.queryInput.value.toLowerCase().indexOf("from ");
    if (indexPos !== -1) {
      this.queryInput.setRangeText("", indexPos + 5, indexPos + 5, "end");
    }
  }
  initPerf() {
    if (!this.displayPerformance) {
      return;
    }
    this.performancePoints = [];
    this.startTime = performance.now();
    this.lastStartTime = this.startTime;
  }
  markPerf() {
    if (!this.displayPerformance) {
      return;
    }
    const now = performance.now();
    const perfPoint = now - this.lastStartTime;
    this.lastStartTime = now;
    this.performancePoints.push(perfPoint);
    this.totalTime = now - this.startTime;
  }
  perfStatus() {
    if (!this.displayPerformance || !this.startTime || this.performancePoints.length === 0) {
      return null;
    }
    const batches = this.performancePoints.length;
    let batchStats = "";
    let batchCount = "";
    if (batches > 1) {
      const avgTime = this.performancePoints.reduce((a, b) => a + b, 0) / batches;
      const maxTime = Math.max(...this.performancePoints);
      const minTime = Math.min(...this.performancePoints);
      const avg = `Avg ${avgTime.toFixed(1)}ms`;
      const max = `Max ${maxTime.toFixed(1)}ms`;
      const min = `Min ${minTime.toFixed(1)}ms`;
      batchStats = `Batch Performance: ${avg}, ${min}, ${max}`;
      batchCount = `${batches} Batches / `;
    }
    return {text: `${batchCount}${this.totalTime.toFixed(1)}ms`, batchStats};
  }
  clearHistory() {
    this.queryHistory.clear();
  }
  selectSavedEntry() {
    let delimiter = ":";
    if (this.selectedSavedEntry != null) {
      let queryStr = "";
      if (this.selectedSavedEntry.query.includes(delimiter) && (this.selectedSavedEntry.query.toLowerCase().indexOf(":select") >= 0 || this.selectedSavedEntry.query.toLowerCase().indexOf(":find") >= 0)) {
        let query = this.selectedSavedEntry.query.split(delimiter);
        this.queryName = query[0];
        queryStr = this.selectedSavedEntry.query.substring(this.selectedSavedEntry.query.indexOf(delimiter) + 1);
      } else {
        queryStr = this.selectedSavedEntry.query;
      }
      this.queryInput.value = queryStr;
      this.queryTooling = this.selectedSavedEntry.useToolingApi;
      this.queryAutocompleteHandler();
      this.selectedSavedEntry = null;
    }
  }
  clearSavedHistory() {
    this.savedHistory.clear();
  }
  addToHistory() {
    this.savedHistory.add({query: this.getQueryToSave(), useToolingApi: this.queryTooling});
  }
  removeFromHistory() {
    this.savedHistory.remove({query: this.getQueryToSave(), useToolingApi: this.queryTooling});
  }
  getQueryToSave() {
    return this.queryName != "" ? this.queryName + ":" + this.queryInput.value.trim() : this.queryInput.value.trim();
  }
  autocompleteReload() {
    this.describeInfo.reloadAll();
  }
  canCopy() {
    return this.exportedData != null;
  }
  canDelete() {
    //In order to allow deletion, we should have at least 1 element and the Id field should have been included in the query
    return this.exportedData
          && (this.exportedData.countOfVisibleRecords === null /* no filtering has been done yet*/ || this.exportedData.countOfVisibleRecords > 0)
          && this.exportedData.records.length < 20001 && !this.exportStatus.includes("Exporting") && this.exportedData?.table?.at(0)?.find(header => header.toLowerCase() === "id");
  }
  copyAsExcel() {
    copyToClipboard(this.exportedData.csvSerialize("\t"));
  }
  copyAsCsv() {
    copyToClipboard(this.exportedData.csvSerialize(this.separator));
  }
  copyAsJson() {
    copyToClipboard(JSON.stringify(this.exportedData.records, null, "  "));
  }
  downloadAsCsv(){
    const csvContent = this.exportedData.csvSerialize(this.separator);
    const filename = `${this.exportedData.records[0].attributes.type}-${new Date().toLocaleDateString()}.csv`;
    downloadCsvFile(csvContent, filename);
  }
  deleteRecords(e) {
    let data = this.exportedData.csvSerialize(this.separator);
    let encodedData = btoa(data);

    let args = new URLSearchParams();
    args.set("host", this.sfHost);
    args.set("data", encodedData);
    if (this.queryTooling) args.set("apitype", "Tooling");

    window.open("data-import.html?" + args, getLinkTarget(e, false));
  }
  /**
   * Notify React that we changed something, so it will rerender the view.
   * Should only be called once at the end of an event or asynchronous operation, since each call can take some time.
   * All event listeners (functions starting with "on") should call this function if they update the model.
   * Asynchronous operations should use the spinFor function, which will call this function after the asynchronous operation completes.
   * Other functions should not call this function, since they are called by a function that does.
   * @param cb A function to be called once React has processed the update.
   */
  didUpdate(cb) {
    if (this.reactCallback) {
      this.reactCallback(cb);
    }
    if (this.testCallback) {
      this.testCallback();
    }
  }
  /**
   * SOQL query autocomplete handling.
   * Put caret at the end of a word or select some text to autocomplete it.
   * Searches for both label and API name.
   * Autocompletes sobject names after the "from" keyword.
   * Autocompletes field names, if the "from" keyword exists followed by a valid object name.
   * Supports relationship fields.
   * Autocompletes field values (picklist values, date constants, boolean values).
   * Autocompletes any textual field value by performing a Salesforce API query when Ctrl+Space is pressed.
   * Inserts all autocomplete field suggestions when Ctrl+Space is pressed.
   * Supports subqueries in where clauses, but not in select clauses.
   */
  isSearchMode() {
    //if query start with "f" like "find" instead of "select"
    return this.editor != null && this.editor.value != null ? this.editor.value.trim().toLowerCase().startsWith("f") : false;
  }
  searchAutocompleteHandler(e = {}) {
    //TODO MOVE TO tokenizer / lexer implem and so on for SOQL
    /*
    * search object after IN
    * keyword and format :
    * FIND {SearchQuery}
    * [ IN [ALL FIELDS|NAME FIELDS|EMAIL FIELDS|PHONE FIELDS|SIDEBAR FIELDS] ]
    * [ RETURNING objectType([[field] [ toLabel(fields)] [convertCurrency(Amount)] [FORMAT()], ]
    *     WHERE ...
    *     ORDER BY fieldOrderByList
    *     LIMIT number_of_rows_to_return
    *     OFFSET number_of_rows_to_skip)],...
    * [ WITH  DIVISION = 'myDiv' ]
    * [ WITH DATA CATEGORY field [AT|ABOVE|BELOW|ABOVE_OR_BELOW] AND... ]
    * [ WITH HIGHLIGHT]
    * [ WITH SNIPPET[(target_length=n)] ]
    * [ WITH NETWORK [IN ('XX',...)|= 'XX'] ]
    * [ WITH PricebookId = 'XX']
    * [ WITH METADATA ='LABELS' ]
    * [ LIMIT n ]
    *
    */
    let vm = this; // eslint-disable-line consistent-this
    let query = vm.editor.value;
    let selStart = vm.editor.selectionStart;
    let selEnd = vm.editor.selectionEnd;
    let ctrlSpace = e.ctrlSpace;
    let beforeSel = query.substring(0, selStart);
    let searchTerm = selStart != selEnd
      ? query.substring(selStart, selEnd)
      : beforeSel.match(/[a-zA-Z0-9_]*$/)[0];
    selStart = selEnd - searchTerm.length;

    //kind of tokenizer/lexer by advancing step by step
    //STEP 1 FIND
    beforeSel = beforeSel.trim();
    if (!beforeSel || !beforeSel.toUpperCase().startsWith("FIND")) {
      vm.autocompleteResults = {
        sobjectName: "",
        title: "Suggestions:",
        results: [{value: "FIND", title: "FIND", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""}]
      };
      return;
    }
    beforeSel = beforeSel.substring(4);
    beforeSel = beforeSel.trim();
    //STEP 2 {[\(|\)|OR|AND|NOT|\s|XXXX]}
    if (!beforeSel || !beforeSel.trim().startsWith("{")) {
      vm.autocompleteResults = {
        sobjectName: "",
        title: "Suggestions:",
        results: [{value: "{", title: "{", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""}]
      };
      return;
    }
    beforeSel = beforeSel.substring(1);
    beforeSel = beforeSel.trim();
    //skip escaped }
    while (beforeSel.indexOf("\\}") > -1 && beforeSel.indexOf("}") > beforeSel.indexOf("\\}")) {
      beforeSel = beforeSel.substring(beforeSel.indexOf("\\}") + 2);
      beforeSel = beforeSel.trim();
    }
    if (!beforeSel || beforeSel.indexOf("}") == -1) {
      vm.autocompleteResults = {
        sobjectName: "",
        title: "keyword or boolean suggestions:",
        results: [{value: "AND", title: "AND", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
          {value: "OR", title: "OR", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
          {value: "NOT", title: "NOT", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""}]
      };
      return;
    }
    beforeSel = beforeSel.substring(beforeSel.indexOf("}") + 1);
    beforeSel = beforeSel.trim();
    let keywords = [{value: "IN", title: "IN", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""},
      {value: "RETURNING", title: "RETURNING", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""},
      {value: "WITH DIVISION", title: "WITH DIVISION", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""},
      {value: "WITH DATA CATEGORY", title: "WITH DATA CATEGORY", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""},
      {value: "WITH HIGHLIGHT", title: "WITH HIGHLIGHT", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""},
      {value: "WITH SNIPPET", title: "WITH SNIPPET", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""},
      {value: "WITH NETWORK", title: "WITH NETWORK", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""},
      {value: "WITH PricebookId", title: "WITH PricebookId", suffix: " = ", rank: 1, autocompleteType: "keyword", dataType: ""},
      {value: "WITH METADATA", title: "WITH METADATA", suffix: " = ", rank: 1, autocompleteType: "keyword", dataType: ""},
      {value: "LIMIT", title: "LIMIT", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""}];

    //STEP 3 check if IN [ALL FIELDS|NAME FIELDS|EMAIL FIELDS|PHONE FIELDS|SIDEBAR FIELDS
    if (beforeSel.toUpperCase().startsWith("IN")) {
      beforeSel = beforeSel.substring(2);
      beforeSel = beforeSel.trim();
      if (!beforeSel.toUpperCase().startsWith("ALL FIELDS")
      && !beforeSel.toUpperCase().startsWith("NAME FIELDS")
      && !beforeSel.toUpperCase().startsWith("EMAIL FIELDS")
      && !beforeSel.toUpperCase().startsWith("PHONE FIELDS")
      && !beforeSel.toUpperCase().startsWith("SIDEBAR FIELDS")) {
        vm.autocompleteResults = {
          sobjectName: "",
          title: "IN suggestions:",
          results: [{value: "ALL FIELDS", title: "ALL FIELDS", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""},
            {value: "NAME FIELDS", title: "NAME FIELDS", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""},
            {value: "EMAIL FIELDS", title: "EMAIL FIELDS", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""},
            {value: "PHONE FIELDS", title: "PHONE FIELDS", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""},
            {value: "SIDEBAR FIELDS", title: "SIDEBAR FIELDS", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""}]
        };
        return;
      }
      beforeSel = beforeSel.substring(beforeSel.toUpperCase().indexOf("FIELDS") + 6);
      beforeSel = beforeSel.trim();
    }
    //STEP 4  RETURNING objectType([[field] [ toLabel(fields)] [convertCurrency(Amount)] [FORMAT()], ] ORDER BY fieldOrderByList LIMIT number_of_rows_to_return OFFSET number_of_rows_to_skip)],...
    if (beforeSel.toUpperCase().startsWith("RETURNING")) {
      beforeSel = beforeSel.substring(9);
      beforeSel = beforeSel.trim();
      let matchObjName = beforeSel.match(/^([a-zA-Z0-9_-]+)/i);
      while (matchObjName && matchObjName.length > 1 && matchObjName[1].toUpperCase() != "WITH" && matchObjName[1].toUpperCase() != "LIMIT") { //object name
        let sobjectName = matchObjName[1];
        beforeSel = beforeSel.substring(sobjectName.length);
        beforeSel = beforeSel.trim();
        if (beforeSel.startsWith("(")) { //field
          if (beforeSel.indexOf(")") == -1) {
            let isAfterWhere = false;
            let whereKeywordMatch = /\s+where\s+([a-z0-9_]*)/i.exec(beforeSel);
            if (whereKeywordMatch) {
              isAfterWhere = true;
            }
            this.autocompleteField(vm, ctrlSpace, sobjectName, isAfterWhere);
            return;
          }
          beforeSel = beforeSel.substring(beforeSel.indexOf(")") + 1);
          beforeSel = beforeSel.trim();
        }
        if (beforeSel.startsWith(",")) { // next object
          beforeSel = beforeSel.substring(1);
          beforeSel = beforeSel.trim();
        }
        if (beforeSel == "") {
          this.autocompleteObject(vm, ctrlSpace);
          return;
        }
        matchObjName = beforeSel.match(/^([a-z0-9_-]+)/i);
      }
      if (beforeSel == "") {
        this.autocompleteObject(vm, ctrlSpace);
        return;
      }
    }
    if (beforeSel.toUpperCase().startsWith("WITH")) {
      vm.autocompleteResults = {
        sobjectName: "",
        title: "Suggestions:",
        results: new Enumerable(keywords)
          .filter(keyword => keyword.value.toLowerCase().includes(searchTerm.toLowerCase()))
          .toArray()
      };
      return;
    }
    //default all remaining keywords
    vm.autocompleteResults = {
      sobjectName: "",
      title: "Suggestions:",
      results: new Enumerable(keywords)
        .filter(keyword => keyword.value.toLowerCase().includes(searchTerm.toLowerCase()))
        .toArray()
    };
    return;
  }

  resultsSort(searchTerm) {
    function sortRank({value, title}) {
      let i = 0;
      if (value.toLowerCase() == searchTerm.toLowerCase()) {
        return i;
      }
      i++;
      if (title.toLowerCase() == searchTerm.toLowerCase()) {
        return i;
      }
      i++;
      if (value.toLowerCase().startsWith(searchTerm.toLowerCase())) {
        return i;
      }
      i++;
      if (title.toLowerCase().startsWith(searchTerm.toLowerCase())) {
        return i;
      }
      i++;
      if (value.toLowerCase().includes("__" + searchTerm.toLowerCase())) {
        return i;
      }
      i++;
      if (value.toLowerCase().includes("_" + searchTerm.toLowerCase())) {
        return i;
      }
      i++;
      if (title.toLowerCase().includes(" " + searchTerm.toLowerCase())) {
        return i;
      }
      i++;
      return i;
    }
    return function(a, b) {
      return sortRank(a) - sortRank(b) || a.rank - b.rank || a.value.localeCompare(b.value);
    };
  }
  autocompleteObject(vm, ctrlSpace) {
    let {globalStatus, globalDescribe} = vm.describeInfo.describeGlobal(vm.queryTooling);
    let query = vm.editor.value;
    let selStart = vm.editor.selectionStart;
    let selEnd = vm.editor.selectionEnd;
    let searchTerm = selStart != selEnd
      ? query.substring(selStart, selEnd)
      : query.substring(0, selStart).match(/[a-zA-Z0-9_]*$/)[0];
    selStart = selEnd - searchTerm.length;

    if (!globalDescribe) {
      switch (globalStatus) {
        case "loading":
          vm.autocompleteResults = {
            sobjectName: "",
            title: "Loading metadata...",
            results: []
          };
          return;
        case "loadfailed":
          vm.autocompleteResults = {
            sobjectName: "",
            title: "Loading metadata failed.",
            results: [{value: "Retry", title: "Retry", reload: true}]
          };
          return;
        default:
          vm.autocompleteResults = {
            sobjectName: "",
            title: "Unexpected error: " + globalStatus,
            results: []
          };
          return;
      }
    }
    if (ctrlSpace) {
      let ar = new Enumerable(globalDescribe.sobjects)
        .filter(sobjectDescribe => sobjectDescribe.queryable && (sobjectDescribe.name.toLowerCase().includes(searchTerm.toLowerCase()) || sobjectDescribe.label.toLowerCase().includes(searchTerm.toLowerCase())))
        .map(sobjectDescribe => sobjectDescribe.name)
        .toArray();
      if (ar.length > 0) {
        vm.editor.focus();
        vm.applyEdit(ar.join(", "), selStart, selEnd, "end");
      }
      vm.queryAutocompleteHandler();
      return;
    }
    vm.autocompleteResults = {
      sobjectName: "",
      title: "Objects suggestions:",
      results: new Enumerable(globalDescribe.sobjects)
        .filter(sobjectDescribe => sobjectDescribe.queryable && (sobjectDescribe.name.toLowerCase().includes(searchTerm.toLowerCase()) || sobjectDescribe.label.toLowerCase().includes(searchTerm.toLowerCase())))
        .map(sobjectDescribe => ({value: sobjectDescribe.name, title: sobjectDescribe.label, suffix: " ", rank: 1, autocompleteType: "object", dataType: ""}))
        .toArray()
        .sort(this.resultsSort(searchTerm))
    };
  }

  suggestFieldValues(){
    //previous object suggestion
    let sobjectName = this.autocompleteResults.sobjectName;
    let useToolingApi = this.queryTooling;
    let selStart = this.editor.selectionStart;
    let selEnd = this.editor.selectionEnd;
    let query = this.editor.value;
    let searchTerm = selStart != selEnd
      ? query.substring(selStart, selEnd)
      : query.substring(0, selStart).match(/[a-zA-Z0-9_]*$/)[0];
    selStart = selEnd - searchTerm.length;
    let contextValueFields = this.autocompleteResults.contextValueFields;
    let fieldNames = contextValueFields.map(contextValueField => contextValueField.sobjectDescribe.name + "." + contextValueField.field.name).join(", ");
    if (contextValueFields.length > 1) {
      this.autocompleteResults = {
        sobjectName,
        title: "Multiple possible fields: " + fieldNames,
        results: []
      };
      return;
    }
    let contextValueField = contextValueFields[0];
    let queryMethod = useToolingApi ? "tooling/query" : this.queryAll ? "queryAll" : "query";
    let acQuery = "select " + contextValueField.field.name + " from " + contextValueField.sobjectDescribe.name;
    if (searchTerm) {
      acQuery += " where " + contextValueField.field.name + " like '%" + searchTerm.replace(/([%_\\'])/g, "\\$1") + "%'";
    }
    acQuery += " group by " + contextValueField.field.name + " limit 100";
    this.spinFor(sfConn.rest("/services/data/v" + apiVersion + "/" + queryMethod + "/?q=" + encodeURIComponent(acQuery), {progressHandler: this.autocompleteProgress})
      .catch(err => {
        if (err.name != "AbortError") {
          this.autocompleteResults = {
            sobjectName,
            title: "Error: " + err.message,
            results: []
          };
        }
        return null;
      })
      .then(data => {
        this.autocompleteProgress = {};
        if (!data) {
          return;
        }
        this.autocompleteResults = {
          sobjectName,
          title: fieldNames + " values suggestions:",
          results: new Enumerable(data.records)
            .map(record => record[contextValueField.field.name])
            .filter(value => value)
            .map(value => ({value: "'" + value + "'", title: value, suffix: " ", rank: 1, autocompleteType: "fieldValue"}))
            .toArray()
            .sort(this.resultsSort(searchTerm))
        };
      }));
    this.autocompleteResults = {
      sobjectName,
      title: "Loading " + fieldNames + " values...",
      results: []
    };
  }
  isInClause(query, start, selStart) {
    const text = query.substring(start, selStart);
    const inMatch = text.match(/\s*(includes|excludes|in)\s*\(\s*/i);
    if (!inMatch) return null;

    // Start after the opening parenthesis
    let pos = inMatch.index + inMatch[0].length;
    let parenDepth = 1;
    let inString = false;

    while (pos < text.length && parenDepth > 0) {
      const char = text[pos];

      // Skip whitespace only when NOT inside a string (whitespace between values is allowed)
      if (!inString && (char === " " || char === "\t" || char === "\n" || char === "\r" || char === ",")) {
        pos++;
        continue;
      }

      // Handle SOQL escape character: \ (backslash)
      if (char === "\\" && inString) {
        // Escaped character - skip the backslash and the next character
        // This handles \' (escaped quote) and \\ (escaped backslash)
        pos += 2;
        continue;
      }

      // Handle quotes
      if (char === "'") {
        // Toggle string state
        inString = !inString;
      } else if (!inString) {
        // Only count parentheses when we're NOT inside a string
        if (char === "(") {
          parenDepth++;
        } else if (char === ")") {
          parenDepth--;
          // If we closed the IN clause parenthesis, we're no longer in the IN clause
          if (parenDepth === 0) {
            if (pos < text.length) {
              return this.isInClause(query, start + pos, selStart);
            } else {
              return null;
            }
          }
        }
      }
      pos++;
    }

    // If we reach here, we're still inside the IN clause (parenDepth > 0)
    // or we're at the end of the text while still inside
    return {0: query.substring(start + inMatch.index, start + pos), 1: inMatch[1]};
  }
  autocompleteField(vm, ctrlSpace, sobjectName, isAfterWhere) {
    let useToolingApi = vm.queryTooling;
    let selStart = vm.editor.selectionStart;
    let selEnd = vm.editor.selectionEnd;
    let query = vm.editor.value;
    let searchTerm = selStart != selEnd
      ? query.substring(selStart, selEnd)
      : query.substring(0, selStart).match(/[a-zA-Z0-9_]*$/)[0];
    selStart = selEnd - searchTerm.length;

    /*
        * The context of a field is used to support queries on relationship fields.
        *
        * For example: If the cursor is at the end of the query "select Id from Contact where Account.Owner.Usern"
        * then the the searchTerm we want to autocomplete is "Usern", the contextPath is "Account.Owner." and the sobjectName is "Contact"
        *
        * When autocompleting field values in the query "select Id from Contact where Account.Type = 'Cus"
        * then the searchTerm we want to autocomplete is "Cus", the fieldName is "Type", the contextPath is "Account." and the sobjectName is "Contact"
        */

    let contextEnd = selStart;
    //after limit no proposition of field or field value
    if (query.substring(0, selStart).match(/(\s+limit)\s+[0-9]*\s*$/i)) {
      vm.autocompleteResults = {
        sobjectName,
        title: "LIMIT suggestions:",
        results: [{value: "1", title: "1", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""},
          {value: "10", title: "10", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""},
          {value: "100", title: "100", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""}
        ]
      };
      return; // don't autocomplete after LIMIT
    }
    // If we are on the right hand side of a comparison operator, autocomplete field values
    //opérator are = < > <= >= != includes() excludes() in like
    // Optimized regex: prevent catastrophic backtracking
    //let isFieldValue = query.substring(0, selStart).match(/\s*(<|>|<=|>=|=|!=|like)\s*('[^']*|\S*)$/i) || query.substring(0, selStart).match(/\s*(includes|excludes|in)\s*\(\s*(?:(?:'[^']*'\s*,\s*)+|')('?[^'\s]*)$/i);
    let isFieldValue = query.substring(0, selStart).match(/\s*(<|>|<=|>=|=|!=|like)\s*('[^']*|\S*)$/i) || this.isInClause(query, 0, selStart);
    let fieldName = null;
    if (isFieldValue) {
      let fieldEnd = selStart - isFieldValue[0].length;
      fieldName = query.substring(0, fieldEnd).match(/[a-zA-Z0-9_]+$/)[0];
      contextEnd = fieldEnd - fieldName.length;
    }
    let isTypeOfWhen = !isAfterWhere && query.substring(0, selStart).match(/\s+TYPEOF\s+([a-z0-9_]*)\s+(?:WHEN\s+[a-z0-9_-]*\s+THEN\s+[a-z0-9_.]*\s+)*WHEN\s+\S*$/i);
    let isTypeOfThen = !isAfterWhere && query.substring(0, selStart).match(/\s+TYPEOF\s+(?:[a-z0-9_]*)\s+(?:WHEN\s+[a-z0-9_-]*\s+THEN\s+[a-z0-9_.]*\s+)*WHEN\s+(\S*)\s+THEN\s+\S*$/i);
    let isTypeOfEnd = !isAfterWhere && query.substring(0, selStart).match(/\s+TYPEOF\s+(?:[a-z0-9_]*)\s+(?:WHEN\s+[a-z0-9_-]*\s+THEN\s+[a-z0-9_.]*\s+)*WHEN\s+(\S*)\s+THEN\s+\S*\s+$/i);
    let isAfterOrderBy = query.substring(0, selStart).match(/[\n\s()]+ORDER\s+BY\s*/i);
    let isAfterGroupBy = query.substring(0, selStart).match(/[\n\s()]+GROUP\s+BY\s*/i);

    /*
    contextSobjectDescribes is a set of describe results for the relevant context sobjects.
    Example: "select Subject, Who.Name from Task"
    The context sobjects for "Subject" is {"Task"}.
    The context sobjects for "Who" is {"Task"}.
    The context sobjects for "Name" is {"Contact", "Lead"}.
    */
    let contextPath = query.substring(0, contextEnd).match(/[a-zA-Z0-9_.]*$/)[0];
    if (isTypeOfThen) {
      sobjectName = isTypeOfThen[1];
    }
    let {sobjectStatus, sobjectDescribe} = vm.describeInfo.describeSobject(useToolingApi, sobjectName);
    if (!sobjectDescribe) {
      switch (sobjectStatus) {
        case "loading":
          vm.autocompleteResults = {
            sobjectName,
            title: "Loading " + sobjectName + " metadata...",
            results: []
          };
          return;
        case "loadfailed":
          vm.autocompleteResults = {
            sobjectName,
            title: "Loading " + sobjectName + " metadata failed.",
            results: [{value: "Retry", title: "Retry", reload: true}]
          };
          return;
        case "notfound":
          vm.autocompleteResults = {
            sobjectName,
            title: "Unknown object: " + sobjectName,
            results: []
          };
          return;
        default:
          vm.autocompleteResults = {
            sobjectName,
            title: "Unexpected error for object: " + sobjectName + ": " + sobjectStatus,
            results: []
          };
          return;
      }
    }
    let contextSobjectDescribes = new Enumerable([sobjectDescribe]);
    let sobjectStatuses = new Map(); // Keys are error statuses, values are an object name with that status. Only one object name in the value, since we only show one error message.
    let lastIsPolymorph = false;
    if (contextPath) {
      let contextFields = contextPath.split(".");
      contextFields.pop(); // always empty
      for (let referenceFieldName of contextFields) {
        let newContextSobjectDescribes = new Set();
        let refTos = contextSobjectDescribes
          .flatMap(contextSobjectDescribe => contextSobjectDescribe.fields)
          .filter(field => field.relationshipName && field.relationshipName.toLowerCase() == referenceFieldName.toLowerCase())
          .flatMap(field => field.referenceTo).toArray();
        if (refTos.length > 10) {
          vm.autocompleteResults = {
            sobjectName,
            contextPath,
            title: "Field suggestions:",
            results: [{value: "Id", title: "Id", suffix: (isAfterWhere || isAfterGroupBy || isAfterOrderBy) ? " " : ", ", rank: 2, autocompleteType: "fieldName", dataType: "id"},
              {value: "Type", title: "Type", suffix: (isAfterWhere || isAfterGroupBy || isAfterOrderBy) ? " " : ", ", rank: 2, autocompleteType: "fieldName", dataType: "string"},
              {value: "Name", title: "Name", suffix: (isAfterWhere || isAfterGroupBy || isAfterOrderBy) ? " " : ", ", rank: 2, autocompleteType: "fieldName", dataType: "string"},
              {value: "CreatedBy.", title: "CreatedBy", suffix: "", rank: 2, autocompleteType: "relationshipName", dataType: ""},
              {value: "LastModifiedBy.", title: "LastModifiedBy", suffix: "", rank: 2, autocompleteType: "relationshipName", dataType: ""},
              {value: "LastModifiedById", title: "LastModifiedById", suffix: (isAfterWhere || isAfterGroupBy || isAfterOrderBy) ? " " : ", ", rank: 2, autocompleteType: "fieldName", dataType: "reference"},
              {value: "CreatedById", title: "CreatedById", suffix: (isAfterWhere || isAfterGroupBy || isAfterOrderBy) ? " " : ", ", rank: 2, autocompleteType: "fieldName", dataType: "reference"},
              {value: "CreatedDate", title: "CreatedDate", suffix: (isAfterWhere || isAfterGroupBy || isAfterOrderBy) ? " " : ", ", rank: 2, autocompleteType: "fieldName", dataType: "datetime"},
              {value: "LastModifiedDate", title: "LastModifiedDate", suffix: (isAfterWhere || isAfterGroupBy || isAfterOrderBy) ? " " : ", ", rank: 2, autocompleteType: "fieldName", dataType: "datetime"}
            ]
          };
          return;
        }
        lastIsPolymorph = (refTos.length > 1);
        for (let referencedSobjectName of refTos) {
          let {sobjectStatus, sobjectDescribe} = vm.describeInfo.describeSobject(useToolingApi, referencedSobjectName);
          if (sobjectDescribe) {
            newContextSobjectDescribes.add(sobjectDescribe);
          } else {
            sobjectStatuses.set(sobjectStatus, referencedSobjectName);
          }
        }
        contextSobjectDescribes = new Enumerable(newContextSobjectDescribes);
      }
    }

    if (!contextSobjectDescribes.some()) {
      if (sobjectStatuses.has("loading")) {
        vm.autocompleteResults = {
          sobjectName,
          title: "Loading " + sobjectStatuses.get("loading") + " metadata...",
          results: []
        };
        return;
      }
      if (sobjectStatuses.has("loadfailed")) {
        vm.autocompleteResults = {
          sobjectName,
          title: "Loading " + sobjectStatuses.get("loadfailed") + " metadata failed.",
          results: [{value: "Retry", title: "Retry", reload: true}]
        };
        return;
      }
      if (sobjectStatuses.has("notfound")) {
        vm.autocompleteResults = {
          sobjectName,
          title: "Unknown object: " + sobjectStatuses.get("notfound"),
          results: []
        };
        return;
      }
      if (sobjectStatuses.size > 0) {
        vm.autocompleteResults = {
          sobjectName,
          title: "Unexpected error: " + sobjectStatus,
          results: []
        };
        return;
      }
      vm.autocompleteResults = {
        sobjectName,
        title: "Unknown field: " + sobjectName + "." + contextPath,
        results: []
      };
      return;
    }
    let isAfterHaving = query.substring(0, selStart).match(/[\n\s()]+(HAVING)[\n\s()]+[a-zA-Z0-9.-_()]+[\n\s()]+\S*$/i);
    let isOperator = isAfterWhere && (isAfterHaving || (!isAfterOrderBy && !isAfterGroupBy && query.substring(0, selStart).match(/[\n\s()]+(AND|WHERE|OR)[\n\s()]+[a-zA-Z0-9.-_()]+[\n\s()]+\S*$/i)));
    let isBooleanOperator = isAfterWhere && !isAfterOrderBy && !isAfterGroupBy && !isFieldValue && !isOperator && query.substring(0, selStart).match(/(\s*[<>=!]+|(?:\s+not)?\s+(includes|excludes|in)\s*\(|\s+like)\s*\(?(?:[^,]*,)*('?[^'\s]*'?)\s+$/i);

    if (isFieldValue) {
      //check if fieldname is polymorphique field
      if (fieldName.toLowerCase() == "type"
        && contextPath != null
        && (contextPath.toLowerCase().endsWith("who.")
        || contextPath.toLowerCase().endsWith("what.")
        || contextPath.toLowerCase().endsWith("owner.")
        || contextPath.toLowerCase().endsWith("LinkedEntity."))) {
        this.autocompleteObject(vm, ctrlSpace);
        return;
      }
      // Autocomplete field values
      let contextValueFields = contextSobjectDescribes
        .flatMap(sobjectDescribe => sobjectDescribe.fields
          .filter(field => field.name.toLowerCase() == fieldName.toLowerCase())
          .map(field => ({sobjectDescribe, field}))
        )
        .toArray();
      if (contextValueFields.length == 0) {
        vm.autocompleteResults = {
          sobjectName,
          title: "Unknown field: " + sobjectDescribe.name + "." + contextPath + fieldName,
          results: []
        };
        return;
      }
      let fieldNames = contextValueFields.map(contextValueField => contextValueField.sobjectDescribe.name + "." + contextValueField.field.name).join(", ");
      if (ctrlSpace) {
        // Since this performs a Salesforce API call, we ask the user to opt in by pressing Ctrl+Space
        vm.suggestFieldValues();
        return;
      }
      let ar = new Enumerable(contextValueFields).flatMap(function* ({field}) {
        yield* field.picklistValues.map(pickVal => ({value: "'" + pickVal.value + "'", title: pickVal.label ?? pickVal.value, suffix: " ", rank: 1, autocompleteType: "picklistValue", dataType: ""}));
        if (field.type == "boolean") {
          yield {value: "true", title: "true", suffix: " ", rank: 1};
          yield {value: "false", title: "false", suffix: " ", rank: 1};
        }
        if (field.type == "date" || field.type == "datetime") {
          let pad = (n, d) => ("000" + n).slice(-d);
          let d = new Date();
          if (field.type == "date") {
            yield {value: pad(d.getFullYear(), 4) + "-" + pad(d.getMonth() + 1, 2) + "-" + pad(d.getDate(), 2), title: "Today", suffix: " ", rank: 1};
          }
          if (field.type == "datetime") {
            yield {
              value: pad(d.getFullYear(), 4) + "-" + pad(d.getMonth() + 1, 2) + "-" + pad(d.getDate(), 2) + "T"
                + pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2) + "." + pad(d.getMilliseconds(), 3)
                + (d.getTimezoneOffset() <= 0 ? "+" : "-") + pad(Math.floor(Math.abs(d.getTimezoneOffset()) / 60), 2)
                + ":" + pad(Math.abs(d.getTimezoneOffset()) % 60, 2),
              title: "Now",
              suffix: " ",
              rank: 1
            };
          }
          // from https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/sforce_api_calls_soql_select_dateformats.htm Winter 24
          yield {value: "YESTERDAY", title: "Starts 12:00:00 the day before and continues for 24 hours.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "TODAY", title: "Starts 12:00:00 of the current day and continues for 24 hours.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "TOMORROW", title: "Starts 12:00:00 after the current day and continues for 24 hours.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_WEEK", title: "Starts 12:00:00 on the first day of the week before the most recent first day of the week and continues for seven full days. First day of the week is determined by your locale.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "THIS_WEEK", title: "Starts 12:00:00 on the most recent first day of the week before the current day and continues for seven full days. First day of the week is determined by your locale.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_WEEK", title: "Starts 12:00:00 on the most recent first day of the week after the current day and continues for seven full days. First day of the week is determined by your locale.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_MONTH", title: "Starts 12:00:00 on the first day of the month before the current day and continues for all the days of that month.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "THIS_MONTH", title: "Starts 12:00:00 on the first day of the month that the current day is in and continues for all the days of that month.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_MONTH", title: "Starts 12:00:00 on the first day of the month after the month that the current day is in and continues for all the days of that month.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_90_DAYS", title: "Starts 12:00:00 of the current day and continues for the last 90 days.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_90_DAYS", title: "Starts 12:00:00 of the current day and continues for the next 90 days.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_N_DAYS:n", title: "For the number n provided, starts 12:00:00 of the current day and continues for the last n days.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_N_DAYS:n", title: "For the number n provided, starts 12:00:00 of the current day and continues for the next n days.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_N_WEEKS:n", title: "For the number n provided, starts 12:00:00 of the first day of the next week and continues for the next n weeks.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "N_DAYS_AGO:n", title: "Starts at 12:00:00 AM on the day n days before the current day and continues for 24 hours. (The range doesn’t include today.)", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_N_WEEKS:n", title: "For the number n provided, starts 12:00:00 of the last day of the previous week and continues for the last n weeks.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "N_WEEKS_AGO:n", title: "Starts at 12:00:00 AM on the first day of the month that started n months before the start of the current month and continues for all the days of that month.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_N_MONTHS:n", title: "For the number n provided, starts 12:00:00 of the first day of the next month and continues for the next n months.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_N_MONTHS:n", title: "For the number n provided, starts 12:00:00 of the last day of the previous month and continues for the last n months.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "N_MONTHS_AGO:n", title: "For the number n provided, starts 12:00:00 of the last day of the previous month and continues for the last n months.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "THIS_QUARTER", title: "Starts 12:00:00 of the current quarter and continues to the end of the current quarter.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_QUARTER", title: "Starts 12:00:00 of the previous quarter and continues to the end of that quarter.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_QUARTER", title: "Starts 12:00:00 of the next quarter and continues to the end of that quarter.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_N_QUARTERS:n", title: "Starts 12:00:00 of the next quarter and continues to the end of the nth quarter.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_N_QUARTERS:n", title: "Starts 12:00:00 of the previous quarter and continues to the end of the previous nth quarter.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "N_QUARTERS_AGO:n", title: "Starts at 12:00:00 AM on the first day of the calendar quarter n quarters before the current calendar quarter and continues to the end of that quarter.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "THIS_YEAR", title: "Starts 12:00:00 on January 1 of the current year and continues through the end of December 31 of the current year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_YEAR", title: "Starts 12:00:00 on January 1 of the previous year and continues through the end of December 31 of that year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_YEAR", title: "Starts 12:00:00 on January 1 of the following year and continues through the end of December 31 of that year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_N_YEARS:n", title: "Starts 12:00:00 on January 1 of the following year and continues through the end of December 31 of the nth year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_N_YEARS:n", title: "Starts 12:00:00 on January 1 of the previous year and continues through the end of December 31 of the previous nth year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "N_YEARS_AGO:n", title: "Starts at 12:00:00 AM on January 1 of the calendar year n years before the current calendar year and continues through the end of December 31 of that year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "THIS_FISCAL_QUARTER", title: "Starts 12:00:00 on the first day of the current fiscal quarter and continues through the end of the last day of the fiscal quarter. The fiscal year is defined in the company profile under Setup at Company Profile | Fiscal Year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_FISCAL_QUARTER", title: "Starts 12:00:00 on the first day of the last fiscal quarter and continues through the end of the last day of that fiscal quarter. The fiscal year is defined in the company profile under Setup at Company Profile | Fiscal Year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_FISCAL_QUARTER", title: "Starts 12:00:00 on the first day of the next fiscal quarter and continues through the end of the last day of that fiscal quarter. The fiscal year is defined in the company profile under Setup at Company Profile | Fiscal Year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_N_FISCAL_QUARTERS:n", title: "Starts 12:00:00 on the first day of the next fiscal quarter and continues through the end of the last day of the nth fiscal quarter. The fiscal year is defined in the company profile under Setup atCompany Profile | Fiscal Year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_N_FISCAL_QUARTERS:n", title: "Starts 12:00:00 on the first day of the last fiscal quarter and continues through the end of the last day of the previous nth fiscal quarter. The fiscal year is defined in the company profile under Setup at Company Profile | Fiscal Year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "N_FISCAL_QUARTERS_AGO:n", title: "Starts at 12:00:00 AM on the first day of the fiscal quarter n fiscal quarters before the current fiscal quarter and continues through the end of the last day of that fiscal quarter.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "THIS_FISCAL_YEAR", title: "Starts 12:00:00 on the first day of the current fiscal year and continues through the end of the last day of the fiscal year. The fiscal year is defined in the company profile under Setup at Company Profile | Fiscal Year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_FISCAL_YEAR", title: "Starts 12:00:00 on the first day of the last fiscal year and continues through the end of the last day of that fiscal year. The fiscal year is defined in the company profile under Setup at Company Profile | Fiscal Year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_FISCAL_YEAR", title: "Starts 12:00:00 on the first day of the next fiscal year and continues through the end of the last day of that fiscal year. The fiscal year is defined in the company profile under Setup at Company Profile | Fiscal Year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "NEXT_N_FISCAL_YEARS:n", title: "Starts 12:00:00 on the first day of the next fiscal year and continues through the end of the last day of the nth fiscal year. The fiscal year is defined in the company profile under Setup at Company Profile | Fiscal Year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "LAST_N_FISCAL_YEARS:n", title: "Starts 12:00:00 on the first day of the last fiscal year and continues through the end of the last day of the previous nth fiscal year. The fiscal year is defined in the company profile under Setup at Company Profile | Fiscal Year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
          yield {value: "N_FISCAL_YEARS_AGO:n", title: "Starts at 12:00:00 AM on the first day of the fiscal year n fiscal years ago and continues through the end of the last day of that fiscal year.", suffix: " ", rank: 1, autocompleteType: "variable", dataType: ""};
        }
        if (field.nillable) {
          yield {value: "null", title: "null", suffix: " ", rank: 1, autocompleteType: "null", dataType: ""};
        }
      })
        .filter(res => res.value.toLowerCase().includes(searchTerm.toLowerCase()) || res.title.toLowerCase().includes(searchTerm.toLowerCase()))
        .toArray()
        .sort(this.resultsSort(searchTerm));
      vm.autocompleteResults = {
        sobjectName,
        isFieldValue,
        contextValueFields,
        title: fieldNames + (ar.length == 0 ? " values (Press Ctrl+Space to load suggestions):" : " values:"),
        results: ar
      };
      return;
    }
    if (isTypeOfWhen) {
      let fieldName = isTypeOfWhen[1];
      vm.autocompleteResults = {
        sobjectName,
        isField: false,
        contextPath,
        title: "typeof suggestions:",
        results: contextSobjectDescribes
          .flatMap(sobjectDescribe => sobjectDescribe.fields)
          .filter(field => field.type != "address" && field.relationshipName && field.relationshipName.toLowerCase() == fieldName.toLowerCase())
          .flatMap(function* (field) {
            for (let refto of field.referenceTo) {
              yield {value: refto, title: refto, suffix: " THEN  END", rank: 1, autocompleteType: "object", dataType: ""};
            }
          })
          .toArray()
          .sort(this.resultsSort(searchTerm))
      };
      return;
    }

    let operators = [];
    if (isOperator) {
      operators.push({value: "IN", title: "IN", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "INCLUDES(", title: "INCLUDES", suffix: ")", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "EXCLUDES(", title: "EXCLUDES", suffix: ")", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "LIKE", title: "LIKE", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "=", title: "=", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "<", title: "<", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: ">", title: ">", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "<=", title: "<=", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: ">=", title: ">=", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "!=", title: "!=", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "NOT", title: "NOT", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""});

    } else if (isBooleanOperator) {
      operators.push({value: "AND", title: "AND", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "OR", title: "OR", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "GROUP", title: "GROUP BY", suffix: " BY", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "ORDER", title: "ORDER BY", suffix: " BY", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "LIMIT", title: "LIMIT", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "HAVING", title: "HAVING", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""});
    } else if (isAfterOrderBy) {
      operators.push({value: "ASC", title: "ASC", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "DESC", title: "DESC", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "HAVING", title: "HAVING", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "LIMIT", title: "LIMIT", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""});
    } else if (isAfterGroupBy) {
      operators.push({value: "HAVING", title: "HAVING", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "LIMIT", title: "LIMIT", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "ORDER", title: "ORDER BY", suffix: " BY", rank: 1, autocompleteType: "keyword", dataType: ""},
        {value: "ROLLUP", title: "ROLLUP", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""});
    } else if (isTypeOfEnd) {
      operators.push({value: "WHEN", title: "WHEN", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""});
      operators.push({value: "END", title: "END", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""});
    }
    if (lastIsPolymorph) {
      operators.push({value: "type", title: "type", suffix: (isAfterWhere || isAfterGroupBy || isAfterOrderBy) ? " " : ", ", rank: 1, autocompleteType: "fieldName", dataType: "string"});
    }
    let prepend = new Enumerable(operators)
      .filter(fn => fn.value.toLowerCase().startsWith(searchTerm.toLowerCase()));
      // Autocomplete field names and functions
    if (ctrlSpace) {
      let ar = contextSobjectDescribes
        .flatMap(sobjectDescribe => sobjectDescribe.fields)
        .filter(field => field.name.toLowerCase().includes(searchTerm.toLowerCase()) || field.label.toLowerCase().includes(searchTerm.toLowerCase()))
        .filter(field => field.type != "address")
        .map(field => contextPath + field.name)
        .toArray();
      if (ar.length > 0) {
        vm.editor.focus();
        vm.applyEdit(ar.join(", ") + (isAfterWhere ? " " : ""), selStart - contextPath.length, selEnd, "end");
      }
      vm.queryAutocompleteHandler();
      return;
    }
    vm.autocompleteResults = {
      sobjectName,
      isField: true,
      contextPath,
      title: contextSobjectDescribes.map(sobjectDescribe => sobjectDescribe.name).toArray().join(", ") + " fields suggestions:",
      results: contextSobjectDescribes
        .flatMap(sobjectDescribe => sobjectDescribe.fields)
        .filter(field => field.type != "address")
        .flatMap(function* (field) {
          yield {value: field.name, title: field.label, suffix: (isAfterWhere || isAfterGroupBy || isAfterOrderBy) ? " " : ", ", rank: 2, autocompleteType: "fieldName", dataType: field.type};
          if (field.relationshipName) {
            yield {value: field.relationshipName + ".", title: field.label, suffix: "", rank: 2, autocompleteType: "relationshipName", dataType: ""};
            if (field.referenceTo != null && field.referenceTo.length > 1) {
              yield {value: "TYPEOF " + field.relationshipName, title: "TYPEOF " + field.label, suffix: " WHEN ", rank: 3, autocompleteType: "variable", dataType: ""};
            }
          }
        })
        .filter(field => field.value.toLowerCase().includes(searchTerm.toLowerCase()) || field.title.toLowerCase().includes(searchTerm.toLowerCase()))
        .concat(prepend)
        .concat(
          new Enumerable(["FIELDS(ALL)", "FIELDS(STANDARD)", "FIELDS(CUSTOM)", "AVG", "COUNT", "COUNT_DISTINCT", "MIN", "MAX", "SUM", "CALENDAR_MONTH", "CALENDAR_QUARTER", "CALENDAR_YEAR", "DAY_IN_MONTH", "DAY_IN_WEEK", "DAY_IN_YEAR", "DAY_ONLY", "FISCAL_MONTH", "FISCAL_QUARTER", "FISCAL_YEAR", "HOUR_IN_DAY", "WEEK_IN_MONTH", "WEEK_IN_YEAR", "convertTimezone", "toLabel", "convertCurrency", "FORMAT", "GROUPING"])
            .filter(fn => fn.toLowerCase().startsWith(searchTerm.toLowerCase()))
            .map(fn => {
              if (fn.includes(")")) { //Exception to easily support functions with hardcoded parameter options
                return {value: fn, title: fn, suffix: "", rank: 3, autocompleteType: "variable", dataType: ""};
              } else {
                return {value: fn, title: fn + "()", suffix: "(", rank: 3, autocompleteType: "variable", dataType: ""};
              }
            })
        )
        .toArray()
        .sort(this.resultsSort(searchTerm))
    };
  }

  autocompleteRelation(ctx, suggestRelation) {
    let useToolingApi = ctx.vm.queryTooling;
    let selStart = ctx.vm.editor.selectionStart;
    let selEnd = ctx.vm.editor.selectionEnd;
    let query = ctx.vm.editor.value;
    let searchTerm = selStart != selEnd
      ? query.substring(selStart, selEnd)
      : query.substring(0, selStart).match(/[a-zA-Z0-9_]*$/)[0];
    selStart = selEnd - searchTerm.length;

    let {sobjectStatus, sobjectDescribe} = ctx.vm.describeInfo.describeSobject(useToolingApi, ctx.parentSObjectName);
    if (!sobjectDescribe) {
      switch (sobjectStatus) {
        case "loading":
          ctx.vm.autocompleteResults = {
            sobjectName: ctx.parentSObjectName,
            title: "Loading " + ctx.parentSObjectName + " metadata...",
            results: []
          };
          return;
        case "loadfailed":
          ctx.vm.autocompleteResults = {
            sobjectName: ctx.parentSObjectName,
            title: "Loading " + ctx.parentSObjectName + " metadata failed.",
            results: [{value: "Retry", title: "Retry", reload: true}]
          };
          return;
        case "notfound":
          ctx.vm.autocompleteResults = {
            sobjectName: ctx.parentSObjectName,
            title: "Unknown object: " + ctx.parentSObjectName,
            results: []
          };
          return;
        default:
          ctx.vm.autocompleteResults = {
            sobjectName: ctx.parentSObjectName,
            title: "Unexpected error for object: " + ctx.parentSObjectName + ": " + sobjectStatus,
            results: []
          };
          return;
      }
    }
    let contextSobjectDescribes = new Enumerable([sobjectDescribe]);
    let ar = contextSobjectDescribes
      .flatMap(sobjectDescribe => sobjectDescribe.childRelationships)
      .filter(relation => relation.relationshipName && (!ctx.fromObject || relation.relationshipName.toLowerCase().startsWith(ctx.fromObject.toLowerCase())))
      .map(rel => ({value: rel.relationshipName, title: rel.relationshipName + "(" + rel.childSObject + "." + rel.field + ")", suffix: " ", rank: 1, autocompleteType: "object", dataType: rel.childSObject}))
      .toArray()
      .sort(this.resultsSort(searchTerm));
    if (ctx.ctrlSpace) {
      if (ar.length > 0) {
        let rel = ar[0];
        ctx.sobjectName = rel.dataType;
      }
      this.selectSuggestion();
      return;
    }
    if (suggestRelation) {
      ctx.vm.autocompleteResults = {
        sobjectName: ctx.parentSObjectName,
        title: "Relations suggestions:",
        results: ar
      };
    } else {
      ctx.sobjectName = ar
        .filter(relation => relation.value && (ctx.fromObject && relation.value.toLowerCase() == ctx.fromObject.toLowerCase()))
        .map(rel => rel.dataType).shift();
    }
    return;
  }

  /**
   * SOQL query autocomplete handling.
   * Put caret at the end of a word or select some text to autocomplete it.
   * Searches for both label and API name.
   * Autocompletes sobject names after the "from" keyword.
   * Autocompletes field names, if the "from" keyword exists followed by a valid object name.
   * Supports relationship fields.
   * Autocompletes field values (picklist values, date constants, boolean values).
   * Autocompletes any textual field value by performing a Salesforce API query when Ctrl+Space is pressed.
   * Inserts all autocomplete field suggestions when Ctrl+Space is pressed.
   * Supports subqueries in where clauses, but not in select clauses.
   */
  queryAutocompleteHandler(e = {}) {
    let vm = this; // eslint-disable-line consistent-this
    if (!vm.editor) return; // editor not yet mounted; describeInfo callbacks may fire before Editor.componentDidMount
    let useToolingApi = vm.queryTooling;
    let query = vm.editor.value;
    let selStart = vm.editor.selectionStart;
    let selEnd = vm.editor.selectionEnd;
    let ctrlSpace = e.ctrlSpace;
    if (e.inputType == "insertLineBreak") {
      let lastLine = query.substring(0, selStart - 1);//remove inserted break
      lastLine = lastLine.substring(lastLine.lastIndexOf("\n") + 1);
      let m = lastLine.match(/^\s+/);
      if (m) {
        vm.applyEdit(m[0], selStart, selEnd, "end");
      }
    }
    if (this.isSearchMode()) {
      this.searchAutocompleteHandler(e);
      return;
    }

    // Skip the calculation when no change is made. This improves performance and prevents async operations (Ctrl+Space) from being canceled when they should not be.
    let newAutocompleteState = [useToolingApi, query, selStart, selEnd].join("$");
    if (newAutocompleteState == vm.autocompleteState && !ctrlSpace && !e.newDescribe) {
      return;
    }
    vm.autocompleteState = newAutocompleteState;

    // Cancel any async operation since its results will no longer be relevant.
    if (vm.autocompleteProgress.abort) {
      vm.autocompleteProgress.abort();
    }

    // Find the token we want to autocomplete. This is the selected text, or the last word before the cursor.
    let searchTerm = selStart != selEnd
      ? query.substring(selStart, selEnd)
      : query.substring(0, selStart).match(/[a-zA-Z0-9_]*$/)[0];
    selStart = selEnd - searchTerm.length;

    let sobjectName, isAfterFrom;
    // Find out what sobject we are querying, by using the word after the "from" keyword.
    let fromRegEx = /(^|\s)from\s+([a-z0-9_]*)/gi;
    let fromKeywordMatch;
    let fromIdx = 0;
    //skip subquery by checking that we have same number of open and close parenthesis before
    while ((fromKeywordMatch = fromRegEx.exec(query)) !== null) {
      fromIdx = fromKeywordMatch.index + fromKeywordMatch[0].length;
      let beforeFrom = query.substring(0, fromKeywordMatch.index);
      let openParenthesisSplit = beforeFrom.split("(");
      if (sobjectName //in sub query after from
        && isAfterFrom
        && selStart > beforeFrom.toLowerCase().lastIndexOf("select") // after start of subquery
        && selStart <= fromKeywordMatch.index + query.substring(fromKeywordMatch.index).indexOf(")")) {
        sobjectName = fromKeywordMatch[2];
        isAfterFrom = selStart > fromKeywordMatch.index + 1;
        break;
      }
      if (!beforeFrom
        || (openParenthesisSplit.length == beforeFrom.split(")").length) // same number of open and close parenthesis = no more in subquery
        || !openParenthesisSplit[openParenthesisSplit.length - 1].trim().toLowerCase().startsWith("select")) { // not a subquery
        sobjectName = fromKeywordMatch[2];
        isAfterFrom = selStart > fromKeywordMatch.index + 1;
      }
    }
    // If we are just after the last "from" keyword, autocomplete the sobject name
    fromRegEx = /(^|\s)from\s*$/gi;
    let fromKeywordMatch2 = fromRegEx.exec(query.substring(0, selStart));
    if (fromKeywordMatch2) {
      let beforeFrom = query.substring(0, fromKeywordMatch2.index);
      let openParenthesisSplit = beforeFrom.split("(");
      //not in subquery before main from
      if (!beforeFrom //nothing before
        || (beforeFrom.split("(").length == beforeFrom.split(")").length) //not in subquery before main from
        || !openParenthesisSplit[openParenthesisSplit.length - 1].trim().toLowerCase().startsWith("select")
        || isAfterFrom) { // after main from => Id IN (SELECT Id...)
        this.autocompleteObject(vm, false);
        return;
      }
    }
    if (!sobjectName) {
      if (query.substring(0, selStart).toLowerCase().indexOf("select") < 0) {
        vm.autocompleteResults = {
          sobjectName: "",
          title: "",
          results: [{value: "SELECT", title: "SELECT", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""}]
        };
        return;
      } else if (selStart <= query.toLowerCase().indexOf("from") || query.substring(0, selStart).match(/select\s+[a-zA-Z0-9_]+\s/gi)) {
        vm.autocompleteResults = {
          sobjectName: "",
          title: "",
          results: [{value: "FROM", title: "FROM", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""}]
        };
        return;
      } else {
        vm.autocompleteResults = {
          sobjectName: "",
          title: "",
          results: [{value: "Id", title: "Id", suffix: " ", rank: 1, autocompleteType: "fieldName", dataType: ""}]
        };
        return;
      }
    }
    let ctx = {vm, ctrlSpace, query, selStart, sobjectName, isAfterFrom, fromIdx};
    if (isAfterFrom || !this.parseSubQuery(ctx)) {
      if (ctx.isAfterFrom && query.substring(ctx.fromIdx, selStart).trim() == "") {
        vm.autocompleteResults = {
          sobjectName: "",
          title: "",
          results: [{value: "WHERE", title: "WHERE", suffix: " ", rank: 1, autocompleteType: "keyword", dataType: ""},
            {value: "GROUP", title: "GROUP BY", suffix: " BY", rank: 1, autocompleteType: "keyword", dataType: ""},
            {value: "ORDER", title: "ORDER BY", suffix: " BY", rank: 1, autocompleteType: "keyword", dataType: ""},
            {value: "LIMIT", title: "LIMIT", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""},
            {value: "HAVING", title: "HAVING", suffix: "", rank: 1, autocompleteType: "keyword", dataType: ""}]
        };
        return;
      }
      this.autocompleteField(vm, ctrlSpace, ctx.sobjectName, ctx.isAfterFrom);
    }
  }
  parseSubQuery(ctx) {
    // If we are in a subquery, try to detect that.
    let subQueryRegExp = /\((\s*select.*?)(\sfrom\s+)([a-z0-9_]*)(\s*.*)\)/gi;
    let subQuery = ctx.query;
    let fromKeywordMatch;
    while ((fromKeywordMatch = subQueryRegExp.exec(subQuery)) !== null) {
      ctx.fromIdx = fromKeywordMatch.index + fromKeywordMatch[1].length + fromKeywordMatch[2].length + fromKeywordMatch[3].length;
      if (fromKeywordMatch
        && fromKeywordMatch.index < ctx.selStart
        && fromKeywordMatch.index + fromKeywordMatch[0].length > ctx.selStart) {
        ctx.parentSObjectName = ctx.sobjectName;
        ctx.fromObject = fromKeywordMatch[3];
        ctx.isAfterFrom = false;
        if (ctx.fromObject === undefined){
          ctx.fromObject = "";
        }

        if (fromKeywordMatch.index + fromKeywordMatch[1].length + 1 >= ctx.selStart){
          //in select : grab relation link for ctx
          this.autocompleteRelation(ctx, false);
          subQueryRegExp = /\((\s*select.*\sfrom\s+)([a-z0-9_]*)(\s*.*)\)/gmi;
          subQuery = ctx.query.substring(0, fromKeywordMatch.index) + "(" + fromKeywordMatch[1];
          if (!ctx.sobjectName){
            ctx.sobjectName = ctx.parentSObjectName;
          }
        } else if (fromKeywordMatch.index + fromKeywordMatch[1].length + fromKeywordMatch[2].length > ctx.selStart){
          return true;
        } else if (fromKeywordMatch.index + fromKeywordMatch[1].length + fromKeywordMatch[2].length + fromKeywordMatch[3].length >= ctx.selStart){
          this.autocompleteRelation(ctx, true);
          return true;
        } else { // after from
          this.autocompleteRelation(ctx, false);
          if (!ctx.sobjectName){
            ctx.sobjectName = ctx.parentSObjectName;
            this.autocompleteRelation(ctx, true);
            return true;
          }
          ctx.isAfterFrom = true;
          return false;
        }
      }
    }
    return false;
  }
  nextWord(sentence, ctx) {
    let regex = /^\s*([a-z0-9_.]+|'[^']+'|,|\(|\)|[<>!]=?|=)/i;
    if (!sentence) {
      ctx.value = "";
      ctx.pos++;
      return;
    }
    let match = regex.exec(sentence.substring(ctx.pos));
    if (match) {
      ctx.value = match[1];
      ctx.pos += match.index + match[0].length;
      return;
    }
    ctx.value = "";
    ctx.pos++;
    return;
  }

  extractColumnFromQuery(query, ctx) {
    if (!ctx) {
      ctx = {value: "", pos: 0};
    }
    this.nextWord(query, ctx);
    let result = {fields: [], objectName: ""};
    if (!ctx.value) {
      return result;
    }
    if (ctx.value.toLowerCase() != "select") {
      return result;
    }
    this.nextWord(query, ctx);
    let expressionIndex = 0;
    let fieldIndex = 0;
    //parse field and subquery
    while (ctx.value && ctx.value.toLowerCase() != "from") {
      let field = {name: ctx.value, position: fieldIndex};
      fieldIndex++;
      if (ctx.value == "(") {
        let subqry = this.extractColumnFromQuery(query, ctx);
        subqry.name = subqry.objectName;
        subqry.position = field.position;
        field = subqry;
        //skip end parenthesis
        this.nextWord(query, ctx);
      } else { //regular field
        this.nextWord(query, ctx);
        if (ctx.value == "(") { //function
          while (ctx.value && ctx.value != ")") {
            this.nextWord(query, ctx);
          }
          if (ctx.value != ",") { //alias
            field.name = ctx.value;
            this.nextWord(query, ctx);
          } else {
            field.name = "expr" + expressionIndex;
            expressionIndex++;
          }
        }
      }
      if (ctx.value == ",") {
        this.nextWord(query, ctx);
      }
      result.fields.push(field);
    }
    if (ctx.value.toLowerCase() == "from") {
      this.nextWord(query, ctx);
      result.objectName = ctx.value;
    }
    this.nextWord(query, ctx);
    let deep = 0;
    while (ctx.value) {
      if (ctx.value == "(") {
        deep++;
      }
      if (ctx.value == ")") {
        if (deep == 0) {
          return result;
        }
        deep--;
      }
      this.nextWord(query, ctx);
    }
    return result;
  }

  removeTypo(query) {
    // Remove double commas
    query = query.replace(/,\s*,/g, ",");
    // Remove comma before FROM
    query = query.replace(/,\s+FROM\s+/gi, " FROM ");
    // Remove trailing comma before FROM
    query = query.replace(/,\s*FROM\s+/gi, " FROM ");
    // Remove multiple spaces
    query = query.replace(/\s+/g, " ");

    return query.trim();
  }
  doExport() {
    let vm = this; // eslint-disable-line consistent-this
    let exportedData = new RecordTable(vm);
    exportedData.isTooling = vm.queryTooling;
    exportedData.describeInfo = vm.describeInfo;
    exportedData.sfHost = vm.sfHost;
    vm.initPerf();
    let query = vm.enableQueryTypoFix ? vm.removeTypo(vm.queryInput.value) : vm.queryInput.value;
    vm.queryInput.value = query; // Update the input value with the cleaned query
    function batchHandler(batch) {
      return batch.catch(err => {
        if (err.name == "AbortError") {
          return {records: [], done: true, totalSize: -1};
        }
        throw err;
      }).then(data => {
        let fieldsResponses = {query: "records", queryAll: "records", "tooling/query": "records", search: "searchRecords", graphql: "data"};
        let isSoql = fieldsResponses[exportedData.queryMethod] === "records";
        if (exportedData.queryMethod === "graphql"){
          exportedData.sobject = Object.keys(data.data.uiapi.query)[0];
          let dataGraph = data.data.uiapi.query[exportedData.sobject].edges.map(record => {
            const firstProperty = Object.keys(record.node)[0];

            const transformed = {};
            if (firstProperty) {
              for (const key in record.node) {
                if (Object.prototype.hasOwnProperty.call(record.node, key)) {
                  transformed[key] = (typeof record.node[key] === "object" && "value" in record.node[key]) ? record.node[key].value : record.node[key];
                  transformed.attributes = {type: exportedData.sobject};
                }
              }
            }
            return transformed;
          });
          exportedData.addToTable(dataGraph);
        } else {
          exportedData.addToTable(data[fieldsResponses[exportedData.queryMethod]]);
        }

        let recs = exportedData.records.length;
        let total = exportedData.totalSize;
        if (data.totalSize != -1) {
          exportedData.totalSize = isSoql ? data.totalSize : recs;
          total = exportedData.totalSize;
        }
        if (!data.done && isSoql) {
          let pr = batchHandler(sfConn.rest(data.nextRecordsUrl, {progressHandler: vm.exportProgress}));
          vm.isWorking = true;
          vm.exportStatus = `Exporting... Completed ${recs} of ${total} record${s(total)}.`;
          vm.exportError = null;
          vm.exportedData = exportedData;
          vm.markPerf();
          vm.updatedExportedData();
          vm.didUpdate();
          return pr;
        }
        vm.queryHistory.add({query, useToolingApi: exportedData.isTooling});
        if (recs == 0) {
          vm.isWorking = false;
          vm.exportStatus = "No data exported." + (total > 0 ? ` ${total} record${s(total)}.` : "");
          vm.exportError = null;
          vm.exportedData = exportedData;
          vm.markPerf();
          vm.updatedExportedData();
          return null;
        } else {
          vm.updateCurrentTabName(exportedData.records[0].attributes.type);
        }
        vm.isWorking = false;
        vm.exportStatus = `Exported ${recs}${recs !== total ? (" of " + total) : ""} record${s(recs)}`;
        vm.exportError = null;
        vm.exportedData = exportedData;
        vm.markPerf();
        vm.updatedExportedData();
        // Store the results in the current tab
        if (vm.queryTabs[vm.activeTabIndex]) {
          vm.queryTabs[vm.activeTabIndex].results = exportedData;
          vm.saveQueryTabs();
        }
        return null;
      }, err => {
        if (err.name != "SalesforceRestError") {
          throw err; // not a SalesforceRestError
        }
        let recs = exportedData.records.length;
        let total = exportedData.totalSize;
        if (total != -1) {
          // We already got some data. Show it, and indicate that not all data was exported
          vm.isWorking = false;
          vm.exportStatus = `Exported ${recs} of ${total} record${s(total)}. Stopped by error.`;
          vm.exportError = null;
          vm.exportedData = exportedData;
          vm.updatedExportedData();
          vm.markPerf();
          return null;
        }
        vm.isWorking = false;
        vm.exportStatus = "Error";
        vm.exportError = err.message;
        vm.exportedData = null;
        vm.updatedExportedData();
        return null;
      });
    }
    this.setQueryMethod(exportedData, query, vm);
    vm.spinFor(batchHandler(sfConn.rest(exportedData.endpoint, exportedData.params))
      .catch(error => {
        console.error(error);
        vm.isWorking = false;
        vm.exportStatus = "Error";
        vm.exportError = "UNEXPECTED EXCEPTION:" + error;
        vm.exportedData = null;
        vm.markPerf();
        vm.updatedExportedData();
      }));
    vm.setResultsFilter("");
    vm.isWorking = true;
    vm.exportStatus = "Exporting...";
    vm.exportError = null;
    vm.exportedData = exportedData;
    vm.updatedExportedData();
  }
  async generateSoql() {
    this.isWorking = true;
    let promptTemplateName = localStorage.getItem(this.sfHost + "_exportAgentForcePrompt");
    const promptTemplate = new PromptTemplate(promptTemplateName ? promptTemplateName : Constants.PromptTemplateSOQL);

    this.spinFor(
      promptTemplate.generate({
        Description: this.soqlPrompt.value
      }).then(result => {
        if (result.result){
          // Extract SOQL from the result
          const soqlMatch = result.result.match(/<soql>(.*?)<\/soql>/);
          const extractedSoql = soqlMatch ? soqlMatch[1] : result.result;
          this.updateCurrentTabQuery(extractedSoql);
          this.queryAutocompleteHandler();
          if (this.queryInput) {
            this.queryInput.value = extractedSoql;
          }
          this.saveQueryTabs();
          this.isWorking = false;
          this.didUpdate();
        } else {
          throw new Error(result.error);
        }
      }).catch(error => {
        console.error(error);
        this.isWorking = false;
        this.exportStatus = "Error";
        this.exportError = "Failed to generate SOQL: " + error;
        this.didUpdate();
      })
    );
  }
  stopExport() {
    this.exportProgress.abort();
  }
  doQueryPlan(){
    let vm = this; // eslint-disable-line consistent-this
    let exportedData = new RecordTable(vm);

    vm.spinFor(sfConn.rest("/services/data/v" + apiVersion + "/query/?explain=" + encodeURIComponent(vm.queryInput.value)).then(res => {
      exportedData.addToTable(res.plans);
      vm.exportStatus = "";
      vm.performancePoints = [];
      vm.exportedData = exportedData;
      vm.updatedExportedData();
      vm.didUpdate();
    }, () => {
      vm.isWorking = false;
    }));
    vm.autocompleteResults = {
      sobjectName: "",
      title: "Query Plan Tool:",
      results: [{value: "Developer Console Query Plan Tool FAQ", title: "Developer Console Query Plan Tool FAQ", rank: 1, autocompleteType: "fieldName", dataType: "", link: "https://help.salesforce.com/s/articleView?id=000386864&type=1"},
        {value: "Get Feedback on Query Performance", title: "Get Feedback on Query Performance", suffix: " ", rank: 1, autocompleteType: "fieldName", dataType: "", link: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_query_explain.htm"},
      ]
    };
  }

  loadQueryTabs(queryFromUrl) {
    const savedTabs = localStorage.getItem(`${this.sfHost}_queryTabs`);
    if (savedTabs) {
      this.queryTabs = JSON.parse(savedTabs);
      if (queryFromUrl) {
        const newTabName = `${Model.QUERY_TAB_PREFIX} ${this.queryTabs.length + 1}`;
        this.queryTabs.push({name: newTabName, query: this.initialQuery, queryTooling: this.queryTooling, queryAll: this.queryAll, results: null, isManuallyRenamed: false});
        this.activeTabIndex = this.queryTabs.length - 1;
        this.saveQueryTabs();
      } else {
        this.activeTabIndex = 0;
      }
    } else {
      this.queryTabs = [{name: `${Model.QUERY_TAB_PREFIX} 1`, query: this.initialQuery, queryTooling: this.queryTooling, queryAll: this.queryAll, results: null, isManuallyRenamed: false}];
      this.activeTabIndex = 0;
    }
  }

  saveQueryTabs() {
    // Create a copy of the tabs without the results property
    const tabsToSave = this.queryTabs.map(tab => ({
      name: tab.name,
      query: tab.query,
      queryTooling: tab.queryTooling,
      queryAll: tab.queryAll,
      isManuallyRenamed: tab.isManuallyRenamed || false
    }));
    localStorage.setItem(`${this.sfHost}_queryTabs`, JSON.stringify(tabsToSave));
  }

  addQueryTab() {
    const newTabName = `${Model.QUERY_TAB_PREFIX} ${this.getNextQueryTabIndex()}`;
    this.queryTabs.push({name: newTabName, query: "", queryTooling: false, queryAll: false, results: null, isManuallyRenamed: false});
    this.activeTabIndex = this.queryTabs.length - 1;
    this.setActiveTab(this.activeTabIndex);
    this.saveQueryTabs();
  }

  removeQueryTab(index) {
    if (this.queryTabs.length > 1) {
      this.queryTabs.splice(index, 1);
      if (this.activeTabIndex >= index) {
        this.activeTabIndex = Math.max(0, this.activeTabIndex - 1);
      }
      this.setActiveTab(this.activeTabIndex);
      this.saveQueryTabs();
      this.didUpdate();
    }
  }

  removeOtherQueryTabs(index) {
    if (this.queryTabs.length > 1) {
      const tabToKeep = this.queryTabs[index];
      this.queryTabs = [tabToKeep];
      this.activeTabIndex = 0;
      this.setActiveTab(this.activeTabIndex);
      this.saveQueryTabs();
      this.didUpdate();
    }
  }

  removeRightQueryTabs(index) {
    if (this.queryTabs.length > index + 1) {
      this.queryTabs.splice(index + 1);
      if (this.activeTabIndex > index) {
        this.activeTabIndex = index;
      }
      this.setActiveTab(this.activeTabIndex);
      this.saveQueryTabs();
      this.didUpdate();
    }
  }

  removeAllQueryTabs() {
    this.queryTabs = [];
    this.addQueryTab();
  }

  setActiveTab(index) {
    this.activeTabIndex = index;
    // Update the query input value to match the current tab's query
    if (this.queryInput) {
      this.queryInput.value = this.queryTabs[index].query;
    }
    this.queryTooling = this.queryTabs[index].queryTooling;
    this.queryAll = this.queryTabs[index].queryAll;
    // Update the exported data with the tab's results
    this.exportedData = this.queryTabs[index].results;
    // Update the UI with the new data
    if (this.exportedData) {
      this.exportStatus = `Loaded ${this.exportedData.records.length} record${s(this.exportedData.records.length)}`;
    } else {
      this.exportStatus = "";
    }
    this.updatedExportedData();
    this.didUpdate();
  }
  /*
  Returns the next available index number for query tabs
  */
  getNextQueryTabIndex() {
    let maxIndex = 0;
    const prefix = Model.QUERY_TAB_PREFIX;

    this.queryTabs.forEach(tab => {
      if (tab.name.startsWith(prefix)) {
        // Extract number from tab name (e.g., "Query 1" -> 1, "Query 2" -> 2)
        const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = tab.name.match(new RegExp(`^${escapedPrefix}\\s+(\\d+)`));
        if (match) {
          const index = parseInt(match[1], 10);
          if (index > maxIndex) {
            maxIndex = index;
          }
        }
      }
    });
    return maxIndex + 1;
  }
  updateCurrentTabQuery(query) {
    if (this.queryTabs[this.activeTabIndex]) {
      this.queryTabs[this.activeTabIndex].query = query;
      this.saveQueryTabs();
    }
  }

  updateCurrentTabProperty(propertyName, value) {
    if (this.queryTabs[this.activeTabIndex]) {
      this.queryTabs[this.activeTabIndex][propertyName] = value;
      this.saveQueryTabs();
    }
  }

  updateCurrentTabName(name) {
    if (this.queryTabs[this.activeTabIndex]
        && !this.queryTabs[this.activeTabIndex].name.includes(name)
        && !this.queryTabs[this.activeTabIndex].isManuallyRenamed) {
      // Check if there are any other tabs with the same name
      let count = 1;
      let newName = name;
      while (this.queryTabs.some(tab => tab.name === newName)) {
        newName = `${name} (${count})`;
        count++;
      }
      this.queryTabs[this.activeTabIndex].name = newName;
      this.saveQueryTabs();
    }
  }

  updateTabName(index, newName) {
    if (this.queryTabs[index] && newName.trim()) {
      let trimmedName = newName.trim();
      // Check if there are any other tabs with the same name
      let count = 1;
      let finalName = trimmedName;
      while (this.queryTabs.some((tab, i) => i !== index && tab.name === finalName)) {
        finalName = `${trimmedName} (${count})`;
        count++;
      }
      this.queryTabs[index].name = finalName;
      this.queryTabs[index].isManuallyRenamed = true;
      this.saveQueryTabs();
      this.didUpdate();
    }
  }

  reorderTabs(fromIndex, toIndex) {
    if (fromIndex >= 0 && toIndex >= 0 && fromIndex < this.queryTabs.length && toIndex < this.queryTabs.length && fromIndex !== toIndex) {
      const [movedTab] = this.queryTabs.splice(fromIndex, 1);
      this.queryTabs.splice(toIndex, 0, movedTab);

      // Update active tab index if the active tab was moved
      if (this.activeTabIndex === fromIndex) {
        this.activeTabIndex = toIndex;
      } else if (this.activeTabIndex > fromIndex && this.activeTabIndex <= toIndex) {
        this.activeTabIndex--;
      } else if (this.activeTabIndex < fromIndex && this.activeTabIndex >= toIndex) {
        this.activeTabIndex++;
      }

      this.saveQueryTabs();
      this.didUpdate();
    }
  }

  getCurrentTabQuery() {
    return this.queryTabs[this.activeTabIndex]?.query || "";
  }
}

function RecordTable(vm) {
  /*
  We don't want to build our own SOQL parser, so we discover the columns based on the data returned.
  This means that we cannot find the columns of cross-object relationships, when the relationship field is null for all returned records.
  We don't care, because we don't need a stable set of columns for our use case.
  */
  let columnIdx = new Map();
  let header = ["_"];
  function discoverColumns(record, prefix, row) {
    for (const field of Object.keys(record)) {
      if (field === "attributes") {
        continue;
      }
      let column = prefix + field;
      let c;
      if (columnIdx.has(column)) {
        c = columnIdx.get(column);
      } else {
        c = header.length;
        columnIdx.set(column, c);
        for (let row of rt.table) {
          row.push(undefined);
        }
        header[c] = column;
        if (typeof record[field] == "object" && record[field] != null && vm.prefHideRelations) {
          rt.colVisibilities.push(false);
        } else { rt.colVisibilities.push(true); }
      }
      row[c] = record[field];
      if (typeof record[field] == "object" && record[field] != null) {
        discoverColumns(record[field], column + ".", row);
      }
    }
  }
  function cellToString(cell) {
    if (cell == null) {
      return "";
    } else if (typeof cell == "object" && cell.attributes && cell.attributes.type) {
      return "[" + cell.attributes.type + "]";
    } else {
      return "" + cell;
    }
  }

  let isVisible = (row, filter) => {
    // If no filter is applied, show all rows
    if (!filter) {
      return true;
    }
    // If no columns are selected, search all columns
    if (!vm.filterColumns || vm.filterColumns.length === 0) {
      return row.some(cell => {
        if (cell == null) {
          return false;
        }
        return cellToString(cell).toLowerCase().includes(filter.toLowerCase());
      });
    }

    // Search in all selected columns
    return vm.filterColumns.some(column => {
      const columnIndex = header.findIndex(col => col === column);
      if (columnIndex === -1) {
        return false;
      }

      const cellValue = String(row[columnIndex]);
      return cellValue
        ? cellToString(cellValue).toLowerCase().includes(filter.toLowerCase())
        : false;
    });
  };

  let rt = {
    records: [],
    table: [],
    rowVisibilities: [],
    colVisibilities: [!vm.prefHideRelations],
    countOfVisibleRecords: null,
    isTooling: false,
    totalSize: -1,
    preventLineWrap: vm.prefPreventLineWrap,
    addToTable(expRecords) {
      rt.records = rt.records.concat(expRecords);
      if (rt.table.length == 0 && expRecords.length > 0) {
        rt.table.push(header);
        rt.rowVisibilities.push(true);
      }
      let filter = vm.resultsFilter;
      for (let record of expRecords) {
        let row = new Array(header.length);
        row[0] = record;
        rt.table.push(row);
        rt.rowVisibilities.push(isVisible(row, filter));
        discoverColumns(record, "", row);
      }
    },
    csvSerialize: separator => rt.getVisibleTable().map(row => row.map(cell => "\"" + cellToString(cell).split("\"").join("\"\"") + "\"").join(separator)).join("\r\n"),
    updateVisibility() {
      let filter = vm.resultsFilter;
      let countOfVisibleRecords = 0;
      for (let r = 1/* always show header */; r < rt.table.length; r++) {
        rt.rowVisibilities[r] = isVisible(rt.table[r], filter);
        if (isVisible(rt.table[r], filter)) countOfVisibleRecords++;
      }
      this.countOfVisibleRecords = countOfVisibleRecords;
      vm.exportStatus = "Filtered " + countOfVisibleRecords + " records out of " + rt.records.length + " records";
    },
    filterColumns(table, colVis) {
      let filteredArray = table.map(row => row.filter((_, index) => colVis[index]));
      return filteredArray;
    },
    updateColumnsVisibility() {
      if (rt.table.length > 1) {
        rt.colVisibilities = rt.table[1].map(cell => !(typeof cell == "object" && cell !== null && vm.prefHideRelations));
      }
    },
    getVisibleTable() {
      if (vm.resultsFilter) {
        let filteredTable = [];
        for (let i = 0; i < rt.table.length; i++) {
          if (rt.rowVisibilities[i]) { filteredTable.push(rt.table[i]); }
        }
        if (vm.prefHideRelations) { return rt.filterColumns(filteredTable, rt.colVisibilities); } else { return filteredTable; }

      }
      if (vm.prefHideRelations) { return rt.filterColumns(rt.table, rt.colVisibilities); } else { return rt.table; }
    }
  };
  return rt;
}

let h = React.createElement;

class App extends React.Component {
  constructor(props) {
    super(props);
    this.onQueryAllChange = this.onQueryAllChange.bind(this);
    this.onQueryToolingChange = this.onQueryToolingChange.bind(this);
    this.onPrefHideRelationsChange = this.onPrefHideRelationsChange.bind(this);
    this.onSelectHistoryEntry = this.onSelectHistoryEntry.bind(this);
    this.onSelectQueryTemplate = this.onSelectQueryTemplate.bind(this);
    this.onClearHistory = this.onClearHistory.bind(this);
    this.onSelectSavedEntry = this.onSelectSavedEntry.bind(this);
    this.onAddToHistory = this.onAddToHistory.bind(this);
    this.onRemoveFromHistory = this.onRemoveFromHistory.bind(this);
    this.onClearSavedHistory = this.onClearSavedHistory.bind(this);
    this.onToggleHelp = this.onToggleHelp.bind(this);
    this.onToggleAI = this.onToggleAI.bind(this);
    this.onToggleExpand = this.onToggleExpand.bind(this);
    this.onToggleSavedOptions = this.onToggleSavedOptions.bind(this);
    this.onExport = this.onExport.bind(this);
    this.onGenerateSoql = this.onGenerateSoql.bind(this);
    this.onCopyQuery = this.onCopyQuery.bind(this);
    this.onQueryPlan = this.onQueryPlan.bind(this);
    this.onCopyAsExcel = this.onCopyAsExcel.bind(this);
    this.onCopyAsCsv = this.onCopyAsCsv.bind(this);
    this.onDownloadAsCsv = this.onDownloadAsCsv.bind(this);
    this.onCopyAsJson = this.onCopyAsJson.bind(this);
    this.onDeleteRecords = this.onDeleteRecords.bind(this);
    this.onResultsFilterInput = this.onResultsFilterInput.bind(this);
    this.onSetQueryName = this.onSetQueryName.bind(this);
    this.onStopExport = this.onStopExport.bind(this);
    this.state = {hideButtonsOption: JSON.parse(localStorage.getItem("hideExportButtonsOption")), isDropdownOpen: false};// Tracks whether the dropdown is open
    this.filterColumns = []; // Initialize as an empty array
    this.onAddTab = this.onAddTab.bind(this);
    this.onRemoveTab = this.onRemoveTab.bind(this);
    this.onRemoveOtherTabs = this.onRemoveOtherTabs.bind(this);
    this.onRemoveRightTabs = this.onRemoveRightTabs.bind(this);
    this.onRemoveAllTabs = this.onRemoveAllTabs.bind(this);
    this.onTabClick = this.onTabClick.bind(this);
    this.onQueryInput = this.onQueryInput.bind(this);
    this.onTabNameEdit = this.onTabNameEdit.bind(this);
    this.onTabNameSubmit = this.onTabNameSubmit.bind(this);
    this.onTabDragStart = this.onTabDragStart.bind(this);
    this.onTabDragOver = this.onTabDragOver.bind(this);
    this.onTabDrop = this.onTabDrop.bind(this);
    this.onTabDragLeave = this.onTabDragLeave.bind(this);
    this.onTabDragEnd = this.onTabDragEnd.bind(this);
    this.onTabContextMenu = this.onTabContextMenu.bind(this);
    this.onOverlayContextMenu = this.onOverlayContextMenu.bind(this);
    this.onCloseContextMenu = this.onCloseContextMenu.bind(this);
    this.onOpenAIQuery = this.onOpenAIQuery.bind(this);
    this.onCloseAIQuery = this.onCloseAIQuery.bind(this);
    this.onAIPromptChange = this.onAIPromptChange.bind(this);
    this.onRunAIQuery = this.onRunAIQuery.bind(this);
    this.onInsertAIQuery = this.onInsertAIQuery.bind(this);
    this.onPickAICandidate = this.onPickAICandidate.bind(this);

    // Tab editing state + AI modal state
    this.state = {
      ...this.state,
      editingTabIndex: -1,
      editingTabName: "",
      draggedTabIndex: -1,
      dropTargetIndex: -1,
      contextMenu: null,
      aiOpen: false,
      aiPrompt: "",
      aiBusy: false,
      aiStatus: "",
      aiError: "",
      aiResult: null,
      aiCandidates: null
    };
  }
  onQueryAllChange(e) {
    let {model} = this.props;
    model.queryAll = e.target.checked;
    model.updateCurrentTabProperty("queryAll", model.queryAll);
    model.didUpdate();
  }
  onQueryToolingChange(e) {
    let {model} = this.props;
    model.queryTooling = e.target.checked;
    model.updateCurrentTabProperty("queryTooling", model.queryTooling);
    model.queryAutocompleteHandler();
    model.didUpdate();
  }
  onPrefHideRelationsChange() {
    let {model} = this.props;
    model.prefHideRelations = !model.prefHideRelations;
    model.updatedExportedData();
    model.didUpdate();
  }
  onSelectHistoryEntry(e) {
    let {model} = this.props;
    model.selectedHistoryEntry = JSON.parse(e.target.value);
    model.selectHistoryEntry();
    model.didUpdate();
  }
  onSelectQueryTemplate(e) {
    let {model} = this.props;
    model.selectedQueryTemplate = e.target.value;
    model.selectQueryTemplate();
    model.didUpdate();
  }
  onClearHistory(e) {
    e.preventDefault();
    let r = confirm("Are you sure you want to clear the query history?");
    if (r == true) {
      let {model} = this.props;
      model.clearHistory();
      model.didUpdate();
    }
  }
  onSelectSavedEntry(e) {
    let {model} = this.props;
    model.selectedSavedEntry = JSON.parse(e.target.value);
    model.selectSavedEntry();
    model.didUpdate();
  }
  onAddToHistory(e) {
    e.preventDefault();
    let {model} = this.props;
    model.addToHistory();
    model.didUpdate();
  }
  onRemoveFromHistory(e) {
    e.preventDefault();
    let r = confirm("Are you sure you want to remove this saved query?");
    let {model} = this.props;
    if (r == true) {
      model.removeFromHistory();
    }
    model.toggleSavedOptions();
    model.didUpdate();
  }
  onClearSavedHistory(e) {
    e.preventDefault();
    let r = confirm("Are you sure you want to remove all saved queries?");
    let {model} = this.props;
    if (r == true) {
      model.clearSavedHistory();
    }
    model.toggleSavedOptions();
    model.didUpdate();
  }
  onToggleHelp(e) {
    e.preventDefault();
    let {model} = this.props;
    model.toggleHelp();
    model.didUpdate();
  }
  onToggleAI(e) {
    e.preventDefault();
    let {model} = this.props;
    model.toggleAI();
    model.didUpdate();
  }
  onToggleExpand(e) {
    e.preventDefault();
    let {model} = this.props;
    model.toggleExpand();
    model.didUpdate();
  }
  onToggleSavedOptions(e) {
    e.preventDefault();
    let {model} = this.props;
    model.toggleSavedOptions();
    model.didUpdate();
  }
  onExport() {
    let {model} = this.props;
    model.doExport();
    model.didUpdate();
  }
  onGenerateSoql() {
    let {model} = this.props;
    model.generateSoql();
    model.didUpdate();
  }
  onCopyQuery() {
    let {model} = this.props;
    let url = new URL(window.location.href);
    let searchParams = url.searchParams;
    searchParams.set("query", model.queryInput.value);
    url.search = searchParams.toString();
    navigator.clipboard.writeText(url.toString());
    navigator.clipboard.writeText(url.toString());
    model.didUpdate();
  }
  onQueryPlan(){
    let {model} = this.props;
    model.doQueryPlan();
    model.didUpdate();
  }
  onCopyAsExcel() {
    let {model} = this.props;
    model.copyAsExcel();
    model.didUpdate();
  }
  onCopyAsCsv() {
    let {model} = this.props;
    model.copyAsCsv();
    model.didUpdate();
  }
  onDownloadAsCsv(){
    let {model} = this.props;
    model.downloadAsCsv();
    model.didUpdate();
  }
  onCopyAsJson() {
    let {model} = this.props;
    model.copyAsJson();
    model.didUpdate();
  }
  onDeleteRecords(e) {
    let {model} = this.props;
    model.deleteRecords(e);
    model.didUpdate();
  }
  onResultsFilterInput(e) {
    let {model} = this.props;
    model.setResultsFilter(e.target.value);
    if (e.target.value.length == 0){
      this.setState({isDropdownOpen: false});
    }
    model.didUpdate();
  }
  onSetQueryName(e) {
    let {model} = this.props;
    model.setQueryName(e.target.value);
    model.didUpdate();
  }
  onStopExport() {
    let {model} = this.props;
    model.stopExport();
    model.didUpdate();
  }
  onAddTab(e) {
    e.preventDefault();
    let {model} = this.props;
    model.addQueryTab();
  }
  onRemoveTab(e, index) {
    e.preventDefault();
    e.stopPropagation();
    let {model} = this.props;
    model.removeQueryTab(index);
  }

  onRemoveOtherTabs() {
    let {model} = this.props;
    if (this.state.contextMenu) {
      model.removeOtherQueryTabs(this.state.contextMenu.index);
    }
    this.onCloseContextMenu();
  }

  onRemoveRightTabs() {
    let {model} = this.props;
    if (this.state.contextMenu) {
      model.removeRightQueryTabs(this.state.contextMenu.index);
    }
    this.onCloseContextMenu();
  }

  onRemoveAllTabs() {
    let {model} = this.props;
    model.removeAllQueryTabs();
    this.onCloseContextMenu();
  }

  onTabClick(e, index) {
    e.preventDefault();
    let {model} = this.props;
    model.setActiveTab(index);
  }

  onQueryInput(e) {
    let {model} = this.props;
    model.updateCurrentTabQuery(e.target.value);
    model.queryAutocompleteHandler();
    model.didUpdate();
  }

  onTabNameEdit(e, index) {
    e.stopPropagation();
    let {model} = this.props;
    this.setState({
      editingTabIndex: index,
      editingTabName: model.queryTabs[index].name
    });
  }

  onTabNameSubmit(e, index) {
    e.preventDefault();
    e.stopPropagation();
    let {model} = this.props;
    if (this.state.editingTabName.trim()) {
      model.updateTabName(index, this.state.editingTabName);
    }
    this.setState({
      editingTabIndex: -1,
      editingTabName: ""
    });
  }

  onTabDragStart(e, index) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/html", e.target);
    this.setState({draggedTabIndex: index, dropTargetIndex: -1});
  }

  onTabDragOver(e, index) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // Update drop target index if different from current
    if (this.state.dropTargetIndex !== index && this.state.draggedTabIndex !== index) {
      this.setState({dropTargetIndex: index});
    }
  }

  onTabDragLeave(e) {
    // Only clear if we're leaving the tabs container entirely
    if (!e.currentTarget.contains(e.relatedTarget)) {
      this.setState({dropTargetIndex: -1});
    }
  }

  onTabDrop(e, index) {
    e.preventDefault();
    let {model} = this.props;
    const fromIndex = this.state.draggedTabIndex;
    if (fromIndex !== -1 && fromIndex !== index) {
      model.reorderTabs(fromIndex, index);
    }
    this.setState({draggedTabIndex: -1, dropTargetIndex: -1});
  }

  onTabDragEnd() {
    // Reset drag state when drag operation ends
    this.setState({draggedTabIndex: -1, dropTargetIndex: -1});
  }

  onTabContextMenu(e, index) {
    e.preventDefault();
    e.stopPropagation();
    this.setState({
      contextMenu: {
        x: e.clientX,
        y: e.clientY,
        index
      }
    });
  }

  onOverlayContextMenu(e) {
    e.preventDefault();
    e.target.style.visibility = "hidden";
    let target = document.elementFromPoint(e.clientX, e.clientY);
    e.target.style.visibility = "visible";

    if (target) {
      let event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: e.clientX,
        clientY: e.clientY
      });
      if (!target.dispatchEvent(event)) {
        return;
      }
    }
    this.onCloseContextMenu();
  }

  onCloseContextMenu() {
    this.setState({contextMenu: null});
  }

  onOpenAIQuery() {
    this.setState({aiOpen: true, aiError: "", aiStatus: "", aiResult: null, aiCandidates: null});
  }
  onCloseAIQuery() {
    this.setState({aiOpen: false, aiBusy: false, aiStatus: "", aiError: "", aiResult: null, aiCandidates: null});
  }
  onAIPromptChange(e) {
    this.setState({aiPrompt: e.target.value});
  }
  async onRunAIQuery() {
    const providerId = localStorage.getItem("aiProvider") || "claude";
    const apiKey = localStorage.getItem("aiApiKey_" + providerId) || "";
    const model = localStorage.getItem("aiModel_" + providerId) || "";
    if (!apiKey) {
      this.setState({aiError: "No API key set for " + (AI_PROVIDERS[providerId]?.name || providerId) + ". Open Options to add one.", aiBusy: false});
      return;
    }
    const {model: dataModel} = this.props;
    this.setState({aiBusy: true, aiError: "", aiResult: null, aiCandidates: null, aiStatus: "Starting…"});
    try {
      const result = await generateAISOQL({
        prompt: this.state.aiPrompt,
        providerId,
        apiKey,
        model,
        useToolingApi: dataModel.queryTooling,
        onProgress: status => this.setState({aiStatus: status})
      });
      if (result.needsChoice) {
        this.setState({aiBusy: false, aiStatus: "Multiple possible SObjects — pick one:", aiCandidates: result.candidates});
      } else {
        this.setState({aiBusy: false, aiStatus: "Generated for " + result.sobjectName, aiResult: result});
      }
    } catch (err) {
      this.setState({aiBusy: false, aiStatus: "", aiError: String(err.message || err)});
    }
  }
  async onPickAICandidate(sobjectName) {
    const providerId = localStorage.getItem("aiProvider") || "claude";
    const apiKey = localStorage.getItem("aiApiKey_" + providerId) || "";
    const model = localStorage.getItem("aiModel_" + providerId) || "";
    const {model: dataModel} = this.props;
    this.setState({aiBusy: true, aiCandidates: null, aiError: "", aiStatus: "Writing SOQL for " + sobjectName + "…"});
    try {
      const result = await writeAISOQLForObject({
        prompt: this.state.aiPrompt,
        sobjectName,
        providerId,
        apiKey,
        model,
        useToolingApi: dataModel.queryTooling,
        onProgress: status => this.setState({aiStatus: status})
      });
      this.setState({aiBusy: false, aiStatus: "Generated for " + result.sobjectName, aiResult: result});
    } catch (err) {
      this.setState({aiBusy: false, aiStatus: "", aiError: String(err.message || err)});
    }
  }
  onInsertAIQuery() {
    const {model} = this.props;
    if (!this.state.aiResult || !model.editor) return;
    model.editor.focus();
    model.editor.select();
    model.applyEdit(this.state.aiResult.soql, 0, model.editor.value.length, "end");
    model.queryAutocompleteHandler();
    this.setState({aiOpen: false, aiBusy: false, aiStatus: "", aiError: "", aiResult: null});
    model.didUpdate();
  }

  componentDidMount() {
    let {model} = this.props;
    model.soqlPrompt = this.refs.prompt;

    // The Editor component owns the SOQL textarea and registers it via model.setEditor (which also sets model.queryInput).
    // Editor handles input/select/keyup/mouseup/keydown autocomplete events and its own ResizeObserver.

    addEventListener("message", e => {
      if (e.data.command === "open-export-autocomplete") {
        model.queryAutocompleteHandler({ctrlSpace: true});
        model.didUpdate();
      } else if (e.data.command === "open-export-execute"){
        model.doExport();
        model.didUpdate();
      }
    });

    addEventListener("keydown", e => {
      if ((e.ctrlKey && e.key == "Enter") || e.key == "F5") {
        e.preventDefault();
        model.doExport();
        model.didUpdate();
      }
    });

    this.scrollTable = initScrollTable(this.refs.scroller);
    model.resultTableCallback = this.scrollTable.dataChange;

    function resize() {
      model.winInnerHeight = innerHeight;
      model.didUpdate();
    }
    addEventListener("resize", resize);
    resize();
  }
  componentDidUpdate() {
    this.recalculateSize();
  }
  recalculateSize() {
    // Investigate if we can use the IntersectionObserver API here instead, once it is available.
    this.scrollTable.viewportChange();
  }
  toggleQueryMoreMenu(){
    this.refs.buttonQueryMenu.classList.toggle("slds-is-open");
  }

  render() {
    let {model} = this.props;
    const perf = model.perfStatus();
    const soqlKeywords = new Map([
      ["select", "blue"], ["from", "blue"], ["where", "blue"], ["group", "blue"], ["by", "blue"],
      ["excludes", "blue"], ["includes", "blue"], ["order", "blue"], ["limit", "blue"],
      ["and", "blue"], ["or", "blue"], ["not", "blue"], ["like", "blue"], ["in", "blue"],
      ["offset", "blue"], ["typeof", "blue"], ["when", "blue"], ["then", "blue"], ["else", "blue"],
      ["end", "blue"], ["using", "blue"], ["scope", "blue"], ["with", "blue"], ["data", "blue"],
      ["category", "blue"], ["rollup", "blue"], ["cube", "blue"], ["having", "blue"], ["asc", "blue"], ["desc", "blue"], ["nulls", "blue"], ["first", "blue"], ["last", "blue"]
    ]);
    const soslKeywords = new Map([
      ["find", "blue"], ["in", "blue"], ["all", "blue"], ["fields", "blue"], ["name", "blue"],
      ["email", "blue"], ["phone", "blue"], ["sidebar", "blue"], ["returning", "blue"],
      ["where", "blue"], ["order", "blue"], ["by", "blue"], ["limit", "blue"], ["offset", "blue"],
      ["with", "blue"], ["division", "blue"], ["data", "blue"], ["category", "blue"],
      ["at", "blue"], ["above", "blue"], ["below", "blue"], ["abov_or_below", "blue"],
      ["and", "blue"], ["or", "blue"], ["not", "blue"], ["like", "blue"],
      ["highlight", "blue"], ["snippet", "blue"], ["network", "blue"], ["metadata", "blue"], ["having", "blue"]
    ]);
    const queryText = model.editor ? model.editor.value : (model.queryInput ? model.queryInput.value : "");
    const editorKeywordColor = queryText.trimStart().toLowerCase().startsWith("find") ? soslKeywords : soqlKeywords;

    // Define utility items for this page (injected as "slots")
    const utilityItems = [
      // Agentforce button (conditional)
      isOptionEnabled("export-agentforce", this.state.hideButtonsOption) && h("div", {
        key: "agentforce-btn",
        className: "slds-builder-header__utilities-item slds-p-top_x-small slds-p-horizontal_x-small sfir-border-none"
      },
      h("button", {
        className: "slds-button slds-button_icon slds-button_icon-border-filled",
        title: "Agentforce",
        onClick: this.onToggleAI
      },
      h("svg", {className: "slds-button__icon", "aria-hidden": "true"},
        h("use", {xlinkHref: "symbols.svg#einstein"})
      )
      )
      ),
      // Help button
      h("div", {
        key: "help-btn",
        className: "slds-builder-header__utilities-item slds-p-top_x-small slds-p-horizontal_x-small sfir-border-none"
      },
      h("button", {
        className: "slds-button slds-button_icon slds-button_icon-border-filled",
        title: "Export Help",
        onClick: this.onToggleHelp
      },
      h("svg", {className: "slds-button__icon", "aria-hidden": "true"},
        h("use", {xlinkHref: "symbols.svg#help"})
      )
      )
      )
    ].filter(Boolean); // Remove null items

    return h("div", {},
      h(PageHeader, {
        pageTitle: "Data Export",
        orgName: model.orgName,
        sfLink: model.sfLink,
        sfHost: model.sfHost,
        spinnerCount: model.spinnerCount,
        ...model.userInfoModel.getProps(),
        utilityItems
      }),

      h("div", {className: "slds-m-top_xx-large sfir-page-container"},
        h("div", {className: "slds-card slds-m-around_medium"},
          h("div", {className: "slds-card__body slds-card__body_inner"},
            h("div", {},
            ),
            h("div", {className: "query-controls"},
              h("h3", {className: "slds-text-heading_small slds-m-bottom_xx-small slds-m-left_xxx-small"}, "Export Query"),
              h("div", {className: "query-history-controls"},
                h("select", {value: "", onChange: this.onSelectQueryTemplate, className: "query-history", title: "Check documentation to customize templates"},
                  h("option", {value: null, disabled: true, defaultValue: true, hidden: true}, "Templates"),
                  model.queryTemplates.map(q => h("option", {key: q, value: q}, q))
                ),
                h("div", {className: "slds-button-group"},
                  h("select", {value: JSON.stringify(model.selectedHistoryEntry), onChange: this.onSelectHistoryEntry, className: "query-history"},
                    h("option", {value: JSON.stringify(null), disabled: true}, "Query History"),
                    model.queryHistory.list.map(q => h("option", {key: JSON.stringify(q), value: JSON.stringify(q)}, q.query.substring(0, 300)))
                  ),
                  h("button", {className: "slds-button slds-button_neutral", onClick: this.onClearHistory, title: "Clear Query History"}, "Clear")
                ),
                h("div", {className: "slds-button-group slds-m-left_small"},
                  h("select", {value: JSON.stringify(model.selectedSavedEntry), onChange: this.onSelectSavedEntry, className: "query-history"},
                    h("option", {value: JSON.stringify(null), disabled: true}, "Saved Queries"),
                    model.savedHistory.list.map(q => h("option", {key: JSON.stringify(q), value: JSON.stringify(q)}, q.query.substring(0, 300)))
                  ),
                  h("input", {placeholder: "Query Label", type: "save", value: model.queryName, onInput: this.onSetQueryName}),
                  h("button", {className: "slds-button slds-button_neutral", onClick: this.onAddToHistory, title: "Add query to saved history"}, "Save Query"),
                  h("button", {className: model.expandSavedOptions ? "slds-button slds-button_neutral toggle contract" : "slds-button slds-button_neutral toggle expand", title: "Show More Options", onClick: this.onToggleSavedOptions}, h("div", {className: "button-toggle-icon"}))
                ),
                h("div", {className: "slds-dropdown-trigger slds-dropdown-trigger_click " + (model.expandSavedOptions ? "slds-is-open" : "slds-is-closed")},
                  h("div", {className: "slds-dropdown slds-dropdown_right"},
                    h("div", {className: "slds-dropdown__item"},
                      h("a", {href: "#", onClick: this.onRemoveFromHistory, title: "Remove query from saved history"}, "Remove Saved Query")
                    ),
                    h("div", {className: "slds-dropdown__item"},
                      h("a", {href: "#", onClick: this.onClearSavedHistory, title: "Clear saved history"}, "Clear Saved Queries")
                    )
                  )
                ),
              ),
              h("div", {className: "slds-grid slds-grid_align-spread"},
                h("div", {className: "slds-col slds-size_7-of-12"},
                  h("label", {className: "slds-checkbox_toggle slds-grid slds-m-right_x-large"},
                    h("span", {className: "slds-form-element__label slds-m-bottom_none"}, "Deleted/Archived Records"),
                    h("input", {
                      type: "checkbox",
                      name: "checkbox-toggle-queryAll",
                      value: "checkbox-toggle-queryAll",
                      role: "switch",
                      checked: model.queryAll,
                      onChange: this.onQueryAllChange,
                      disabled: model.queryTooling
                    }),
                    h("span", {id: "checkbox-toggle-queryAll", className: "slds-checkbox_faux_container"},
                      h("span", {className: "slds-checkbox_faux"}),
                      h("span", {className: "slds-checkbox_on"}, "Enabled"),
                      h("span", {className: "slds-checkbox_off"}, "Disabled")
                    )
                  )
                ),
                h("div", {className: "slds-col slds-col-size_5-of-12"},
                  h("label", {className: "slds-checkbox_toggle slds-grid slds-grid_align-end", title: "With the tooling API you can query more metadata, but you cannot query regular data"},
                    h("span", {className: "slds-form-element__label slds-m-bottom_none"}, "Tooling API"),
                    h("input", {
                      type: "checkbox",
                      name: "checkbox-toggle-tooling",
                      value: "checkbox-toggle-tooling",
                      role: "switch",
                      checked: model.queryTooling,
                      onChange: this.onQueryToolingChange,
                      disabled: model.queryAll
                    }),
                    h("span", {id: "checkbox-toggle-tooling", className: "slds-checkbox_faux_container"},
                      h("span", {className: "slds-checkbox_faux"}),
                      h("span", {className: "slds-checkbox_on"}, "Enabled"),
                      h("span", {className: "slds-checkbox_off"}, "Disabled")
                    )
                  )),
              ),
            ),
            h("div", {
              className: "query-tabs",
              onDragLeave: this.onTabDragLeave
            },
            model.queryTabs.map((tab, index) =>
              h("div", {
                key: index,
                className: `query-tab ${index === model.activeTabIndex ? "active" : ""} ${this.state.draggedTabIndex === index ? "dragging" : ""} ${this.state.dropTargetIndex === index ? "drop-target" : ""}`,
                onClick: e => this.onTabClick(e, index),
                draggable: true,
                onDragStart: e => this.onTabDragStart(e, index),
                onDragOver: e => this.onTabDragOver(e, index),
                onDragLeave: e => this.onTabDragLeave(e),
                onDrop: e => this.onTabDrop(e, index),
                onDragEnd: e => this.onTabDragEnd(e),
                onContextMenu: e => this.onTabContextMenu(e, index)
              },
              this.state.editingTabIndex === index
                ? h("input", {
                  type: "text",
                  className: "query-tab-name-input",
                  value: this.state.editingTabName,
                  onChange: e => this.setState({editingTabName: e.target.value}),
                  onBlur: e => this.onTabNameSubmit(e, index),
                  onKeyPress: e => {
                    if (e.key === "Enter") {
                      this.onTabNameSubmit(e, index);
                    }
                  },
                  onKeyDown: e => {
                    if (e.key === "Escape") {
                      this.setState({
                        editingTabIndex: -1,
                        editingTabName: ""
                      });
                    }
                    e.stopPropagation();
                  },
                  autoFocus: true,
                  onClick: e => e.stopPropagation()
                })
                : h("span", {
                  className: "query-tab-name",
                  onDoubleClick: e => this.onTabNameEdit(e, index),
                  title: "Double-click to edit tab name"
                }, tab.name),
              h("span", {
                className: "query-tab-close",
                onClick: e => this.onRemoveTab(e, index),
                title: "Close tab"
              }, "×")
              )
            ),
            h("div", {
              className: "add-tab-button",
              onClick: this.onAddTab,
              title: "Add new query tab"
            }, "+")
            ),
            h(Editor, {
              model,
              keywordColor: editorKeywordColor,
              keywordCaseSensitive: false
            }),
            h("div", {ref: el => { model.autocompleteResultBox = el; }, className: "autocomplete-results autocomplete-results-over", hidden: !model.displaySuggestion || !model.autocompleteResults.results || model.autocompleteResults.results.length === 0, style: {top: model.suggestionTop + "px", left: model.suggestionLeft + "px"}},
              (model.autocompleteResults.results || []).map((r, ri) => h("div", {tabIndex: 0, title: r.title, className: "autocomplete-result " + (r.autocompleteType || "") + " " + (r.dataType || "") + (ri == model.activeSuggestion ? " active" : ""), key: r.value + "_" + ri, onMouseDown: e => { e.preventDefault(); model.autocompleteClick(r, ri); model.didUpdate(); }},
                h("div", {className: "autocomplete-icon"}),
                r.value
              ))
            ),
            h("div", {className: "autocomplete-box" + (model.expandAutocomplete ? " expanded" : "")},
              h("div", {className: "autocomplete-header"},
                h("span", {className: "slds-m-left_xx-small"}, model.autocompleteResults.title),
                h("ul", {className: "slds-button-group-row flex-right"},
                  h("li", {className: "slds-button-group-item"},
                    h("button", {tabIndex: 1, disabled: model.isWorking, onClick: this.onExport, title: "Ctrl+Enter / F5", className: "slds-button slds-button_brand"}, "Run Export")
                  ),
                  h("li", {className: "slds-button-group-item"},
                    h("button", {onClick: this.onOpenAIQuery, title: "Describe a query in plain English; AI picks the SObject and writes SOQL.", className: "slds-button slds-button_neutral"}, "AI Query")
                  ),
                  h("li", {className: "slds-button-group-item"},
                    isOptionEnabled("export-query", this.state.hideButtonsOption) ? h("button", {tabIndex: 2, onClick: this.onCopyQuery, title: "Copy query url", className: "slds-button slds-button_neutral copy-id"}, "Export Query") : null
                  ),
                  h("li", {className: "slds-button-group-item"},
                    h("button", {tabIndex: 3, onClick: this.onQueryPlan, title: "Run Query Plan", className: "slds-button slds-button_neutral"}, "Query Plan")
                  ),
                  h("li", {className: "slds-button-group-item"},
                    h("a", {tabIndex: 4, className: "slds-button slds-button_neutral", hidden: !model.autocompleteResults.sobjectName, href: model.showDescribeUrl(), target: "_blank", title: "Show field info for the " + model.autocompleteResults.sobjectName + " object"}, model.autocompleteResults.sobjectName + " Field Info")
                  ),
                  h("li", {className: "slds-button-group-item"},
                    h("div", {className: "slds-dropdown-trigger"},
                      h("button", {tabIndex: 5, href: "#", className: model.expandAutocomplete ? "slds-button slds-button_icon slds-button_icon-more toggle contract" : "slds-button slds-button_icon slds-button_icon-more toggle expand", onClick: this.onToggleExpand, title: "Show all suggestions or only the first line"},
                        h("div", {className: "button-icon"}),
                        h("div", {className: "button-toggle-icon"})
                      )
                    ))
                ),
              ),
            ),
            !this.state.aiOpen ? null : h("div", {className: "ai-modal-backdrop", onClick: this.onCloseAIQuery},
              h("div", {className: "ai-modal", onClick: e => e.stopPropagation()},
                h("div", {className: "ai-modal-header"},
                  h("h2", {}, "AI Query"),
                  h("button", {className: "ai-modal-close", onClick: this.onCloseAIQuery, title: "Close"}, "×")
                ),
                h("p", {className: "ai-modal-help"}, "Describe the data you want in plain English. The AI will pick the most likely SObject from your org and write a SOQL query."),
                h("textarea", {
                  className: "ai-modal-input",
                  placeholder: "e.g. Find all General Accounting Units where Name is like Bob",
                  value: this.state.aiPrompt,
                  onChange: this.onAIPromptChange,
                  disabled: this.state.aiBusy,
                  autoFocus: true
                }),
                this.state.aiStatus ? h("div", {className: "ai-modal-status"}, this.state.aiStatus) : null,
                this.state.aiError ? h("div", {className: "ai-modal-error"}, this.state.aiError) : null,
                this.state.aiCandidates ? h("div", {className: "ai-modal-candidates"},
                  this.state.aiCandidates.map((c, i) => h("button", {
                    key: c.sobjectName,
                    className: "ai-candidate-btn",
                    onClick: () => this.onPickAICandidate(c.sobjectName),
                    disabled: this.state.aiBusy
                  },
                    h("span", {className: "ai-candidate-index"}, (i + 1) + "."),
                    h("span", {className: "ai-candidate-name"}, c.sobjectName),
                    c.label && c.label !== c.sobjectName ? h("span", {className: "ai-candidate-label"}, c.label) : null,
                    c.reason ? h("span", {className: "ai-candidate-reason"}, c.reason) : null
                  ))
                ) : null,
                this.state.aiResult ? h("div", {className: "ai-modal-result"},
                  h("div", {className: "ai-modal-result-label"}, "Generated SOQL (target: " + this.state.aiResult.sobjectName + "):"),
                  h("pre", {className: "ai-modal-result-soql"}, this.state.aiResult.soql)
                ) : null,
                h("div", {className: "ai-modal-actions"},
                  h("a", {href: "options.html?host=" + encodeURIComponent(model.sfHost || ""), target: "_blank", className: "ai-modal-options-link"}, "Configure API keys →"),
                  h("div", {className: "ai-modal-actions-right"},
                    h("button", {onClick: this.onCloseAIQuery, className: "slds-button slds-button_neutral", disabled: this.state.aiBusy}, "Cancel"),
                    this.state.aiResult
                      ? h("button", {onClick: this.onInsertAIQuery, className: "slds-button slds-button_brand"}, "Insert into editor")
                      : h("button", {onClick: this.onRunAIQuery, className: "slds-button slds-button_brand", disabled: this.state.aiBusy || !this.state.aiPrompt.trim()}, this.state.aiBusy ? "Generating…" : "Generate SOQL")
                  )
                )
              )
            ),
            !model.showHelp ? null : h("div", {className: "slds-box slds-theme_info slds-m-top_medium"},
              h("h3", {className: "slds-text-heading_small slds-m-bottom_small"}, "Export Help"),
              h("p", {className: "slds-m-bottom_x-small"}, "Use for quick one-off data exports. Enter a ",
                h("a", {href: "https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/sforce_api_calls_soql.htm", target: "_blank"}, "SOQL"),
                h("a", {href: "https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/sforce_api_calls_sosl.htm", target: "_blank"}, ", SOSL "),
                h("a", {href: "https://developer.salesforce.com/docs/platform/graphql/guide/query-record-examples.html", target: "_blank"}, ", GraphQL"),
                " query in the box above and press Export."
              ),
              h("p", {className: "slds-m-bottom_x-small"}, "Press Ctrl+Space to insert all field name autosuggestions or to load suggestions for field values."),
              h("p", {className: "slds-m-bottom_x-small"}, "Press Ctrl+Enter or F5 to execute the export."),
              h("p", {}, "Those shortcuts can be customized in chrome://extensions/shortcuts"),
              h("p", {className: "slds-m-bottom_x-small"}, "Supports the full SOQL language. The columns in the CSV output depend on the returned data. Using subqueries may cause the output to grow rapidly. Bulk API is not supported. Large data volumes may freeze or crash your browser.")
            ),
            h("div", {hidden: !model.showAI},
              h("h3", {className: "slds-text-heading_small slds-m-top_medium slds-m-left_xxx-small"}, "Agentforce SOQL query builder"),
              h("p", {className: "slds-m-bottom_xx-small slds-m-left_xxx-small"}, "Enter a description of the SOQL you want to be generated"),
              h("textarea", {id: "prompt", ref: "prompt"}),
              h("div", {className: "slds-text-align_right slds-m-top_small"},
                h("button", {tabIndex: 1, onClick: this.onGenerateSoql, title: "Generate SOQL", className: "slds-button slds-button_brand"}, "Generate SOQL")
              )
            )
          )),
        h(
          "div",
          {
            className: "slds-card slds-m-horizontal_medium slds-m-bottom_medium",
            id: "result-area",
            style: {
              flex: "1 1 0",
              minHeight: 0,
              display: "flex",
              flexDirection: "column"
            }
          },
          h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column"}},
            h("div", {className: "result-bar"},
              h("h3", {className: "slds-text-heading_small"}, "Export Result"),
              h("div", {className: "slds-button-group slds-m-left_small"},
                h("button", {className: "slds-button slds-button_neutral", disabled: !model.canCopy(), onClick: this.onCopyAsExcel, title: "Copy exported data to clipboard for pasting into Excel or similar"}, "Copy (Excel)"),
                h("button", {className: "slds-button slds-button_neutral", disabled: !model.canCopy(), onClick: this.onCopyAsCsv, title: "Copy exported data to clipboard for saving as a CSV file"}, "Copy (CSV)"),
                h("button", {className: "slds-button slds-button_neutral", disabled: !model.canCopy(), onClick: this.onCopyAsJson, title: "Copy raw API output to clipboard"}, "Copy (JSON)"),
                h("button", {className: "slds-button slds-button_neutral", disabled: !model.canCopy(), onClick: this.onDownloadAsCsv, title: "Download as a CSV file"},
                  h("svg", {className: "slds-button__icon"},
                    h("use", {xlinkHref: "symbols.svg#download"})
                  )
                ),
                h("button", {className: "slds-button slds-button_neutral", disabled: !model.canCopy(), onClick: this.onPrefHideRelationsChange, title: `${model.prefHideRelations ? "Show" : "Hide"} Object Columns`},
                  h("svg", {className: `slds-button__icon ${model.prefHideRelations ? "" : "disabled"}`},
                    h("use", {xlinkHref: "symbols.svg#hide"})
                  )
                ),
                isOptionEnabled("delete", this.state.hideButtonsOption)
                  ? h("button", {className: "slds-button slds-button_destructive", disabled: !model.canDelete(), onClick: this.onDeleteRecords, title: "Open the 'Data Import' page with preloaded records to delete (< 20k records). 'Id' field needs to be queried"}, "Delete Records") : null,
              ),
              model.exportedData && model.exportedData.table[0]?.length > 0 && !model.exportError ? h("div", {className: "slds-form-element"},
                h("div", {className: "slds-form-element__control slds-input-has-icon slds-input-has-icon_left slds-m-left_small slds-button-group"},
                  h("input", {
                    className: "slds-input slds-button slds-m-around_none",
                    placeholder: model.filterColumns?.length > 0
                      ? `Filter by (${model.filterColumns.length})`
                      : "Filter",
                    type: "search",
                    value: model.resultsFilter,
                    onInput: this.onResultsFilterInput
                  }),
                  h("button", {className: "toggle expand slds-button slds-button_neutral" + (this.state.isDropdownOpen ? " contract" : " expand"), title: "Show More Filters", disabled: !model.exportedData, onClick: () => this.setState({isDropdownOpen: !this.state.isDropdownOpen})}, h("div", {className: "button-toggle-icon"})),
                  this.state.isDropdownOpen && h("div", {className: "dropdown-menu"},
                    model.exportedData?.table[0]
                      ?.filter(column => column !== "_")
                      .map(column =>
                        h("div", {
                          key: column,
                          className: `dropdown-item ${model.filterColumns?.includes(column) ? "selected" : ""}`,
                          onClick: () => {
                            if (model.filterColumns?.includes(column)) {
                              model.filterColumns = model.filterColumns.filter(c => c !== column);
                            } else {
                              model.filterColumns = [...(model.filterColumns || []), column];
                            }
                            model.setResultsFilter(model.resultsFilter);
                            this.setState({}); // Trigger re-render
                          }
                        },
                        h("input", {
                          type: "checkbox",
                          checked: model.filterColumns?.includes(column) || false,
                          readOnly: true
                        }),
                        column
                        )
                      )
                  )
                )
              ) : null,
              h("span", {className: "result-status flex-right"},
                h("span", {className: `slds-badge slds-theme_${model.exportError ? "error" : "success"}`}, model.exportStatus),
                perf && h("span", {className: "result-info", title: perf.batchStats}, perf.text),
                h("button", {className: "slds-button slds-button_destructive slds-m-left_small", disabled: !model.isWorking, onClick: this.onStopExport}, "Stop")
              ),
            ),
            h("textarea", {
              className: "slds-box slds-theme_error",
              readOnly: true,
              value: nullToEmptyString(model.exportError),
              hidden: model.exportError == null,
              style: {flex: "1 1 0", minHeight: 0, resize: "none"}
            }),
            h("div", {
              ref: "scroller",
              hidden: model.exportError != null,
              style: {flex: "1 1 0", minHeight: 0, maxHeight: "100%", overflowY: "auto"}
            }
            )
          )
        ),
        this.state.contextMenu && h("div", {
          className: "context-menu-overlay",
          style: {position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000},
          onClick: this.onCloseContextMenu,
          onContextMenu: this.onOverlayContextMenu
        }),
        this.state.contextMenu && h("div", {
          className: "slds-dropdown slds-dropdown_left slds-dropdown_small",
          style: {position: "fixed", top: this.state.contextMenu.y, left: this.state.contextMenu.x, zIndex: 3000}
        },
        h("ul", {className: "slds-dropdown__list", role: "menu"},
          h("li", {className: "slds-dropdown__item", role: "presentation"},
            h("a", {href: "#", role: "menuitem", tabIndex: "-1", onClick: (e) => { e.preventDefault(); this.onRemoveTab(e, this.state.contextMenu.index); this.onCloseContextMenu(); }},
              h("span", {className: "slds-truncate", title: "Close"}, "Close")
            )
          ),
          h("li", {className: "slds-dropdown__item", role: "presentation"},
            h("a", {href: "#", role: "menuitem", tabIndex: "-1", onClick: (e) => { e.preventDefault(); this.onRemoveOtherTabs(); }},
              h("span", {className: "slds-truncate", title: "Close Others"}, "Close Others")
            )
          ),
          h("li", {className: "slds-dropdown__item", role: "presentation"},
            h("a", {href: "#", role: "menuitem", tabIndex: "-1", onClick: (e) => { e.preventDefault(); this.onRemoveRightTabs(); }},
              h("span", {className: "slds-truncate", title: "Close to the Right"}, "Close to the Right")
            )
          ),
          h("li", {className: "slds-dropdown__item", role: "presentation"},
            h("a", {href: "#", role: "menuitem", tabIndex: "-1", onClick: (e) => { e.preventDefault(); this.onRemoveAllTabs(); }},
              h("span", {className: "slds-truncate", title: "Close All"}, "Close All")
            )
          )
        )
        )
      )
    );
  }
}

{

  let args = new URLSearchParams(location.search);
  let sfHost = args.get("host");
  let hash = new URLSearchParams(location.hash); //User-agent OAuth flow
  if (!sfHost && hash) {
    sfHost = decodeURIComponent(hash.get("instance_url")).replace(/^https?:\/\//i, "");
  }
  initButton(sfHost, true);
  sfConn.getSession(sfHost).then(() => {

    let root = document.getElementById("root");
    let model = new Model({sfHost, args});
    model.reactCallback = cb => {
      ReactDOM.render(h(App, {model}), root, cb);
    };

    // Update host and sfLink after session is established (for OAuth redirect case)
    if (sfConn.instanceHostname && model.sfHost !== sfConn.instanceHostname) {
      model.sfHost = sfConn.instanceHostname;
      model.sfLink = "https://" + sfConn.instanceHostname;
      model.orgName = model.sfHost.split(".")[0]?.toUpperCase() || "";
    }

    ReactDOM.render(h(App, {model}), root);
  });

}

function getSeparator() {
  let separator = ",";
  if (localStorage.getItem("csvSeparator")) {
    separator = localStorage.getItem("csvSeparator");
  }
  return separator;
}
