const state = {
  items: [],
  revision: null,
  selectedIndex: -1,
  dirty: false,
  saving: false,
  search: '',
  accessMode: null,
  modelConfig: null,
  modelSaving: false,
  knowledge: null,
  knowledgeImporting: false,
  toastTimer: null,
};

const elements = {
  statusDot: document.querySelector('#status-dot'),
  serviceStatus: document.querySelector('#service-status'),
  contentCount: document.querySelector('#content-count'),
  knowledgeCount: document.querySelector('#knowledge-count'),
  saveStatus: document.querySelector('#save-status'),
  modelStatus: document.querySelector('#model-status'),
  saveAll: document.querySelector('#save-all'),
  addItem: document.querySelector('#add-item'),
  search: document.querySelector('#content-search'),
  itemList: document.querySelector('#item-list'),
  visibleCount: document.querySelector('#visible-count'),
  emptyState: document.querySelector('#empty-state'),
  contentForm: document.querySelector('#content-form'),
  recordPosition: document.querySelector('#record-position'),
  fieldId: document.querySelector('#field-id'),
  fieldQuestions: document.querySelector('#field-questions'),
  fieldKeywords: document.querySelector('#field-keywords'),
  fieldAnswer: document.querySelector('#field-answer'),
  answerLength: document.querySelector('#answer-length'),
  deleteItem: document.querySelector('#delete-item'),
  duplicateItem: document.querySelector('#duplicate-item'),
  moveUp: document.querySelector('#move-up'),
  moveDown: document.querySelector('#move-down'),
  testerForm: document.querySelector('#tester-form'),
  testQuestion: document.querySelector('#test-question'),
  testSubmit: document.querySelector('#test-submit'),
  quickQuestions: document.querySelector('#quick-questions'),
  answerCard: document.querySelector('#answer-card'),
  answerText: document.querySelector('#answer-text'),
  answerMeta: document.querySelector('#answer-meta'),
  openKnowledgeDialog: document.querySelector('#open-knowledge-dialog'),
  knowledgeDialog: document.querySelector('#knowledge-dialog'),
  knowledgeForm: document.querySelector('#knowledge-form'),
  closeKnowledgeDialog: document.querySelector('#close-knowledge-dialog'),
  cancelKnowledgeImport: document.querySelector('#cancel-knowledge-import'),
  knowledgeFiles: document.querySelector('#knowledge-files'),
  selectedFiles: document.querySelector('#selected-files'),
  knowledgeModeInputs: [
    ...document.querySelectorAll('input[name="knowledge-mode"]'),
  ],
  replaceConfirmRow: document.querySelector('#replace-confirm-row'),
  replaceConfirm: document.querySelector('#replace-confirm'),
  knowledgeMessage: document.querySelector('#knowledge-message'),
  importKnowledge: document.querySelector('#import-knowledge'),
  refreshKnowledge: document.querySelector('#refresh-knowledge'),
  knowledgeDocumentCount: document.querySelector('#knowledge-document-count'),
  knowledgeChunkCount: document.querySelector('#knowledge-chunk-count'),
  knowledgeStorageState: document.querySelector('#knowledge-storage-state'),
  knowledgeDocumentList: document.querySelector('#knowledge-document-list'),
  openModelDialog: document.querySelector('#open-model-dialog'),
  modelDialog: document.querySelector('#model-dialog'),
  modelForm: document.querySelector('#model-form'),
  closeModelDialog: document.querySelector('#close-model-dialog'),
  cancelModelSettings: document.querySelector('#cancel-model-settings'),
  saveModelSettings: document.querySelector('#save-model-settings'),
  testModelSettings: document.querySelector('#test-model-settings'),
  modelBaseUrl: document.querySelector('#model-base-url'),
  modelApiKey: document.querySelector('#model-api-key'),
  modelKeyState: document.querySelector('#model-key-state'),
  modelClearRow: document.querySelector('#model-clear-row'),
  modelClearKey: document.querySelector('#model-clear-key'),
  modelName: document.querySelector('#model-name'),
  modelAnswerMode: document.querySelector('#model-answer-mode'),
  modelTemperature: document.querySelector('#model-temperature'),
  modelMaxTokens: document.querySelector('#model-max-tokens'),
  modelTimeout: document.querySelector('#model-timeout'),
  modelSystemPrompt: document.querySelector('#model-system-prompt'),
  modelMessage: document.querySelector('#model-message'),
  logoutAdmin: document.querySelector('#logout-admin'),
  deleteDialog: document.querySelector('#delete-dialog'),
  deleteMessage: document.querySelector('#delete-message'),
  confirmDelete: document.querySelector('#confirm-delete'),
  toast: document.querySelector('#toast'),
};

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set('Accept', 'application/json');
  const hasBody = options.body !== undefined;
  const formDataBody = hasBody && options.body instanceof FormData;
  if (hasBody && !formDataBody) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: hasBody
      ? formDataBody
        ? options.body
        : JSON.stringify(options.body)
      : undefined,
  });

  const raw = await response.text();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { message: raw };
    }
  }

  if (!response.ok) {
    const error = new Error(payload.message || `请求失败（${response.status}）`);
    error.status = response.status;
    error.code = payload.error;
    if (response.status === 401) {
      window.setTimeout(() => window.location.replace('/'), 0);
    }
    throw error;
  }

  return payload;
}

function showToast(message, type = 'success') {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', type === 'error');
  elements.toast.classList.add('show');
  state.toastTimer = setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 3200);
}

function setServiceStatus(status, text) {
  elements.statusDot.classList.remove('online', 'offline');
  if (status === 'online') {
    elements.statusDot.classList.add('online');
  } else if (status === 'offline') {
    elements.statusDot.classList.add('offline');
  }
  elements.serviceStatus.textContent = text;
}

function updateSaveState(text) {
  if (text) {
    elements.saveStatus.textContent = text;
  } else if (state.saving) {
    elements.saveStatus.textContent = '正在保存';
  } else if (state.dirty) {
    elements.saveStatus.textContent = '有未保存更改';
  } else if (state.revision) {
    elements.saveStatus.textContent = '全部已保存';
  } else {
    elements.saveStatus.textContent = '等待载入';
  }

  elements.saveAll.disabled = !state.dirty || state.saving || !state.revision;
  elements.saveAll.textContent = state.saving ? '正在保存…' : '保存全部更改';
}

function markDirty() {
  state.dirty = true;
  updateSaveState();
}

function currentItem() {
  return state.items[state.selectedIndex] ?? null;
}

function normalizeSearchText(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function renderList() {
  elements.itemList.replaceChildren();
  const query = normalizeSearchText(state.search);
  const visibleItems = state.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (!query) {
        return true;
      }
      const searchable = [
        item.id,
        ...item.questions,
        ...item.keywords,
        item.answer,
      ].join('');
      return normalizeSearchText(searchable).includes(query);
    });

  if (visibleItems.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'list-empty';
    empty.textContent = state.items.length
      ? '没有找到匹配内容，换个关键词试试。'
      : '还没有问答内容。点击右上角“＋”新建第一条。';
    elements.itemList.append(empty);
  }

  for (const { item, index } of visibleItems) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'content-item';
    button.classList.toggle('selected', index === state.selectedIndex);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === state.selectedIndex));

    const title = document.createElement('span');
    title.className = 'content-item-title';
    title.textContent = item.questions[0] || '未填写标准问题';

    const meta = document.createElement('span');
    meta.className = 'content-item-meta';
    meta.textContent = item.id || '尚未填写内容 ID';

    button.append(title, meta);
    button.addEventListener('click', () => {
      state.selectedIndex = index;
      renderList();
      renderEditor();
    });
    elements.itemList.append(button);
  }

  elements.visibleCount.textContent = `${visibleItems.length} 条内容`;
  elements.contentCount.textContent = String(state.items.length);
}

function renderQuickQuestions() {
  elements.quickQuestions.replaceChildren();
  const item = currentItem();
  if (!item) {
    return;
  }

  for (const question of item.questions.filter(Boolean).slice(0, 3)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quick-question';
    button.textContent = question;
    button.title = `测试：${question}`;
    button.addEventListener('click', () => {
      elements.testQuestion.value = question;
      elements.testerForm.requestSubmit();
    });
    elements.quickQuestions.append(button);
  }
}

function clearInvalidFields() {
  for (const field of elements.contentForm.querySelectorAll('.field.invalid')) {
    field.classList.remove('invalid');
  }
}

function renderEditor() {
  const item = currentItem();
  elements.emptyState.hidden = Boolean(item);
  elements.contentForm.hidden = !item;

  if (!item) {
    renderQuickQuestions();
    return;
  }

  clearInvalidFields();
  elements.fieldId.value = item.id;
  elements.fieldQuestions.value = item.questions.join('\n');
  elements.fieldKeywords.value = item.keywords.join('，');
  elements.fieldAnswer.value = item.answer;
  elements.answerLength.textContent = String(item.answer.length);
  elements.recordPosition.textContent = `${state.selectedIndex + 1} / ${state.items.length}`;
  elements.moveUp.disabled = state.selectedIndex <= 0;
  elements.moveDown.disabled = state.selectedIndex >= state.items.length - 1;
  renderQuickQuestions();
}

function parseLines(value) {
  return value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseKeywords(value) {
  return [...new Set(
    value
      .split(/[,，\r\n]+/)
      .map((part) => part.trim())
      .filter(Boolean),
  )];
}

function syncEditorToState(event) {
  const item = currentItem();
  if (!item) {
    return;
  }

  const target = event.target;
  if (target === elements.fieldId) {
    item.id = target.value;
  } else if (target === elements.fieldQuestions) {
    item.questions = parseLines(target.value);
  } else if (target === elements.fieldKeywords) {
    item.keywords = parseKeywords(target.value);
  } else if (target === elements.fieldAnswer) {
    item.answer = target.value;
    elements.answerLength.textContent = String(target.value.length);
  } else {
    return;
  }

  target.closest('.field')?.classList.remove('invalid');
  markDirty();
  renderList();
  if (target === elements.fieldQuestions) {
    renderQuickQuestions();
  }
}

function createUniqueId(base = `faq-${Date.now().toString(36)}`) {
  const used = new Set(state.items.map((item) => item.id));
  if (!used.has(base)) {
    return base;
  }

  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function addItem() {
  state.items.push({
    id: createUniqueId(),
    questions: [],
    keywords: [],
    answer: '',
  });
  state.selectedIndex = state.items.length - 1;
  state.search = '';
  elements.search.value = '';
  markDirty();
  renderList();
  renderEditor();
  elements.fieldQuestions.focus();
}

function duplicateItem() {
  const item = currentItem();
  if (!item) {
    return;
  }

  const firstQuestion = item.questions[0] || '新问答';
  const duplicate = {
    id: createUniqueId(`${item.id || 'faq'}-copy`),
    questions: [`${firstQuestion}（副本）`],
    keywords: [...item.keywords],
    answer: item.answer,
  };
  state.items.splice(state.selectedIndex + 1, 0, duplicate);
  state.selectedIndex += 1;
  markDirty();
  renderList();
  renderEditor();
  elements.fieldQuestions.focus();
  elements.fieldQuestions.select();
}

function moveItem(offset) {
  const destination = state.selectedIndex + offset;
  if (
    state.selectedIndex < 0 ||
    destination < 0 ||
    destination >= state.items.length
  ) {
    return;
  }

  const [item] = state.items.splice(state.selectedIndex, 1);
  state.items.splice(destination, 0, item);
  state.selectedIndex = destination;
  markDirty();
  renderList();
  renderEditor();
}

function deleteCurrentItem() {
  if (!currentItem()) {
    return;
  }
  state.items.splice(state.selectedIndex, 1);
  state.selectedIndex = Math.min(state.selectedIndex, state.items.length - 1);
  markDirty();
  renderList();
  renderEditor();
  showToast('已从当前编辑中删除；点击“保存全部更改”后正式生效。');
}

function normalizedQuestion(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function validateItems() {
  const ids = new Map();
  const questions = new Map();

  for (const [index, item] of state.items.entries()) {
    if (!item.id.trim()) {
      return { index, field: 'id', message: '请填写内容 ID。' };
    }
    if (ids.has(item.id.trim())) {
      return { index, field: 'id', message: `内容 ID 与第 ${ids.get(item.id.trim()) + 1} 条重复。` };
    }
    ids.set(item.id.trim(), index);

    if (!item.questions.length) {
      return { index, field: 'questions', message: '请至少填写一种用户问法。' };
    }
    if (!item.keywords.length) {
      return { index, field: 'keywords', message: '请至少填写一个匹配关键词。' };
    }
    if (!item.answer.trim()) {
      return { index, field: 'answer', message: '请填写已确认内容。' };
    }

    for (const question of item.questions) {
      const normalized = normalizedQuestion(question);
      if (!normalized) {
        return { index, field: 'questions', message: '问法不能只包含空白或标点。' };
      }
      if (questions.has(normalized)) {
        return {
          index,
          field: 'questions',
          message: `存在重复问法，与第 ${questions.get(normalized) + 1} 条冲突。`,
        };
      }
      questions.set(normalized, index);
    }
  }

  return null;
}

function showValidationError(validation) {
  state.selectedIndex = validation.index;
  renderList();
  renderEditor();
  const field = elements.contentForm.querySelector(`[name="${validation.field}"]`);
  field?.closest('.field')?.classList.add('invalid');
  field?.focus();
  showToast(validation.message, 'error');
}

async function saveContent() {
  if (!state.dirty || state.saving || !state.revision) {
    return;
  }

  const validation = validateItems();
  if (validation) {
    showValidationError(validation);
    return;
  }

  const selectedId = currentItem()?.id;
  state.saving = true;
  updateSaveState();

  try {
    const result = await requestJson('/api/content', {
      method: 'PUT',
      body: {
        revision: state.revision,
        items: state.items,
      },
    });
    state.items = result.items;
    state.revision = result.revision;
    state.accessMode = result.accessMode;
    state.selectedIndex = Math.max(
      0,
      state.items.findIndex((item) => item.id === selectedId),
    );
    if (state.items.length === 0) {
      state.selectedIndex = -1;
    }
    state.dirty = false;
    renderList();
    renderEditor();
    showToast('内容已保存并立即生效。');
  } catch (error) {
    updateSaveState(
      error.status === 409 ? '内容版本有冲突' : '保存失败',
    );
    showToast(error.message, 'error');
  } finally {
    state.saving = false;
    updateSaveState();
  }
}

async function loadContent() {
  try {
    const result = await requestJson('/api/content');
    state.items = result.items;
    state.revision = result.revision;
    state.accessMode = result.accessMode;
    state.selectedIndex = state.items.length ? 0 : -1;
    state.dirty = false;
    renderList();
    renderEditor();
    updateSaveState();
    return true;
  } catch (error) {
    state.revision = null;
    elements.contentCount.textContent = '—';
    updateSaveState(
      error.status === 401 ? '需要重新登录' : '无法读取内容',
    );
    showToast(error.message, 'error');

    return false;
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) {
    return '—';
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '时间未知';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function setKnowledgeSnapshot(snapshot) {
  state.knowledge = snapshot;
  elements.knowledgeCount.textContent = String(snapshot.documentCount ?? 0);
  elements.knowledgeDocumentCount.textContent = String(
    snapshot.documentCount ?? 0,
  );
  elements.knowledgeChunkCount.textContent = String(snapshot.chunkCount ?? 0);
  elements.knowledgeStorageState.textContent = snapshot.revision
    ? '已持久化'
    : '待初始化';
  renderKnowledgeDocuments();
}

function renderSelectedKnowledgeFiles() {
  const files = [...elements.knowledgeFiles.files];
  elements.selectedFiles.replaceChildren();
  if (files.length === 0) {
    elements.selectedFiles.textContent = '尚未选择文件。';
    return;
  }

  const list = document.createElement('ul');
  list.className = 'selected-file-list';
  for (const file of files) {
    const item = document.createElement('li');
    item.textContent = `${file.name} · ${formatBytes(file.size)}`;
    item.title = file.name;
    list.append(item);
  }
  elements.selectedFiles.append(list);
}

function selectedKnowledgeMode() {
  return (
    elements.knowledgeModeInputs.find((input) => input.checked)?.value ??
    'append'
  );
}

function syncKnowledgeMode() {
  const replacing = selectedKnowledgeMode() === 'replace';
  elements.replaceConfirmRow.hidden = !replacing;
  elements.replaceConfirm.required = replacing;
  if (!replacing) {
    elements.replaceConfirm.checked = false;
  }
}

function renderKnowledgeDocuments() {
  elements.knowledgeDocumentList.replaceChildren();
  const documents = state.knowledge?.documents ?? [];
  if (documents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'knowledge-list-empty';
    empty.textContent = '尚未导入外部知识文件。';
    elements.knowledgeDocumentList.append(empty);
    return;
  }

  for (const knowledgeDocument of [...documents].reverse()) {
    const article = document.createElement('article');
    article.className = 'knowledge-document';

    const heading = document.createElement('div');
    heading.className = 'knowledge-document-heading';
    const name = document.createElement('div');
    name.className = 'knowledge-document-name';
    const title = document.createElement('strong');
    title.textContent = knowledgeDocument.filename;
    title.title = knowledgeDocument.filename;
    const meta = document.createElement('small');
    meta.textContent = [
      formatBytes(knowledgeDocument.size),
      `${Number(knowledgeDocument.textLength).toLocaleString('zh-CN')} 字符`,
      `${knowledgeDocument.chunkCount} 个片段`,
      formatDate(knowledgeDocument.importedAt),
    ].join(' · ');
    name.append(title, meta);
    const type = document.createElement('span');
    type.className = 'file-type-badge';
    type.textContent = knowledgeDocument.extension.replace('.', '');
    heading.append(name, type);

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '查看提取预览';
    const preview = document.createElement('pre');
    preview.textContent = knowledgeDocument.preview || '（无预览）';
    details.append(summary, preview);

    const actions = document.createElement('div');
    actions.className = 'knowledge-document-actions';
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = '下载原文件';
    download.addEventListener('click', () => {
      void downloadKnowledgeDocument(knowledgeDocument);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = '删除';
    remove.addEventListener('click', () => {
      void deleteKnowledgeDocument(knowledgeDocument);
    });
    actions.append(download, remove);

    article.append(heading, details, actions);
    elements.knowledgeDocumentList.append(article);
  }
}

async function loadKnowledge({ silent = false } = {}) {
  try {
    const snapshot = await requestJson('/api/knowledge');
    setKnowledgeSnapshot(snapshot);
    return true;
  } catch (error) {
    state.knowledge = null;
    elements.knowledgeCount.textContent = '—';
    elements.knowledgeDocumentCount.textContent = '—';
    elements.knowledgeChunkCount.textContent = '—';
    elements.knowledgeStorageState.textContent = '读取失败';
    renderKnowledgeDocuments();
    if (!silent && error.status !== 401) {
      showToast(error.message, 'error');
    }
    return false;
  }
}

function setKnowledgeBusy(busy) {
  state.knowledgeImporting = busy;
  elements.importKnowledge.disabled = busy;
  elements.knowledgeFiles.disabled = busy;
  elements.closeKnowledgeDialog.disabled = busy;
  elements.cancelKnowledgeImport.disabled = busy;
  elements.refreshKnowledge.disabled = busy;
  for (const input of elements.knowledgeModeInputs) {
    input.disabled = busy;
  }
  elements.importKnowledge.textContent = busy
    ? '正在解析并保存…'
    : '导入并保存';
}

async function importKnowledgeFiles(event) {
  event.preventDefault();
  if (state.knowledgeImporting) {
    return;
  }

  const files = [...elements.knowledgeFiles.files];
  if (files.length === 0) {
    elements.knowledgeMessage.textContent = '请先选择要导入的文件。';
    elements.knowledgeFiles.focus();
    return;
  }
  if (files.length > 10) {
    elements.knowledgeMessage.textContent = '每次最多导入 10 个文件。';
    return;
  }
  const oversized = files.find((file) => file.size > 10 * 1024 * 1024);
  if (oversized) {
    elements.knowledgeMessage.textContent = `文件“${oversized.name}”超过 10 MB 上限。`;
    return;
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > 30 * 1024 * 1024) {
    elements.knowledgeMessage.textContent = '所选文件合计超过 30 MB 上限。';
    return;
  }

  const mode = selectedKnowledgeMode();
  if (mode === 'replace' && !elements.replaceConfirm.checked) {
    elements.knowledgeMessage.textContent = '请先确认替换现有外部知识文件。';
    elements.replaceConfirm.focus();
    return;
  }

  const formData = new FormData();
  formData.append('mode', mode);
  for (const file of files) {
    formData.append('files', file, file.name);
  }

  setKnowledgeBusy(true);
  elements.knowledgeMessage.textContent = '正在提取文字、切分片段并持久化…';
  elements.knowledgeMessage.classList.remove('success');
  try {
    const result = await requestJson('/api/knowledge/import', {
      method: 'POST',
      body: formData,
    });
    setKnowledgeSnapshot(result);
    elements.knowledgeFiles.value = '';
    renderSelectedKnowledgeFiles();
    const importedCount = result.imported?.length ?? 0;
    const skippedCount = result.skipped?.length ?? 0;
    elements.knowledgeMessage.textContent =
      importedCount > 0
        ? `已导入并保存 ${importedCount} 个文件${
            skippedCount ? `，跳过 ${skippedCount} 个重复文件` : ''
          }。`
        : `未新增文件，已跳过 ${skippedCount} 个重复文件。`;
    elements.knowledgeMessage.classList.add('success');
    showToast('知识库已持久化并立即生效。');
    void refreshHealth();
  } catch (error) {
    elements.knowledgeMessage.textContent = error.message;
    elements.knowledgeMessage.classList.remove('success');
    showToast(error.message, 'error');
  } finally {
    setKnowledgeBusy(false);
  }
}

async function deleteKnowledgeDocument(knowledgeDocument) {
  if (
    !window.confirm(
      `确定删除“${knowledgeDocument.filename}”吗？原文件和已提取的知识片段都会删除。`,
    )
  ) {
    return;
  }

  try {
    const snapshot = await requestJson(
      `/api/knowledge/${encodeURIComponent(knowledgeDocument.id)}`,
      { method: 'DELETE' },
    );
    setKnowledgeSnapshot(snapshot);
    elements.knowledgeMessage.textContent = `已删除“${knowledgeDocument.filename}”。`;
    elements.knowledgeMessage.classList.add('success');
    showToast('知识文件已删除。');
  } catch (error) {
    elements.knowledgeMessage.textContent = error.message;
    elements.knowledgeMessage.classList.remove('success');
    showToast(error.message, 'error');
  }
}

async function downloadKnowledgeDocument(knowledgeDocument) {
  try {
    const response = await fetch(
      `/api/knowledge/${encodeURIComponent(knowledgeDocument.id)}/download`,
      { headers: { Accept: '*/*' } },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.replace('/');
      }
      throw new Error(payload.message || '原文件下载失败。');
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = knowledgeDocument.filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function setModelStatus(config) {
  if (!config) {
    elements.modelStatus.textContent = '无法读取';
    return;
  }
  if (!config.configured) {
    elements.modelStatus.textContent = '等待配置';
    return;
  }

  const connectionStatus = config.connection?.status;
  const label =
    connectionStatus === 'available'
      ? '连接可用'
      : connectionStatus === 'unavailable'
        ? '连接异常'
        : '待验证';
  elements.modelStatus.textContent = `${config.model} · ${label}`;
}

function populateModelForm(config) {
  elements.modelBaseUrl.value = config.baseUrl ?? '';
  elements.modelApiKey.value = '';
  elements.modelApiKey.placeholder = config.hasApiKey
    ? '已安全保存；留空保持不变'
    : '输入 API Key';
  elements.modelKeyState.textContent = config.hasApiKey
    ? '服务器已保存'
    : '尚未保存';
  elements.modelClearRow.hidden = !config.hasApiKey;
  elements.modelClearKey.checked = false;
  elements.modelName.value = config.model ?? '';
  elements.modelAnswerMode.value = config.answerMode ?? 'grounded';
  elements.modelTemperature.value = String(config.temperature ?? 0.2);
  elements.modelMaxTokens.value = String(config.maxTokens ?? 800);
  elements.modelTimeout.value = String((config.timeoutMs ?? 30_000) / 1_000);
  elements.modelSystemPrompt.value = config.systemPrompt ?? '';
  elements.modelMessage.textContent = '';
  elements.modelMessage.classList.remove('success');
}

async function loadModelConfig() {
  try {
    const config = await requestJson('/api/model-config');
    state.modelConfig = config;
    setModelStatus(config);
    return true;
  } catch (error) {
    state.modelConfig = null;
    setModelStatus(null);
    if (error.status !== 401) {
      showToast(error.message, 'error');
    }
    return false;
  }
}

async function openModelSettings() {
  if (!state.modelConfig) {
    const loaded = await loadModelConfig();
    if (!loaded) {
      return;
    }
  }
  populateModelForm(state.modelConfig);
  if (!elements.modelDialog.open) {
    elements.modelDialog.showModal();
  }
  requestAnimationFrame(() => elements.modelBaseUrl.focus());
}

function modelRequestFromForm() {
  return {
    provider: 'openai-compatible',
    baseUrl: elements.modelBaseUrl.value.trim(),
    apiKey: elements.modelApiKey.value,
    clearApiKey: elements.modelClearKey.checked,
    model: elements.modelName.value.trim(),
    answerMode: elements.modelAnswerMode.value,
    temperature: Number(elements.modelTemperature.value),
    maxTokens: Number(elements.modelMaxTokens.value),
    timeoutMs: Number(elements.modelTimeout.value) * 1_000,
    systemPrompt: elements.modelSystemPrompt.value.trim(),
  };
}

function setModelFormBusy(busy) {
  state.modelSaving = busy;
  elements.saveModelSettings.disabled = busy;
  elements.testModelSettings.disabled = busy;
  elements.closeModelDialog.disabled = busy;
  elements.cancelModelSettings.disabled = busy;
}

async function saveModelConfig(event) {
  event.preventDefault();
  if (state.modelSaving || !elements.modelForm.reportValidity()) {
    return;
  }

  const requestBody = modelRequestFromForm();
  const connectionChanged =
    requestBody.baseUrl !== (state.modelConfig?.baseUrl ?? '') ||
    requestBody.model !== (state.modelConfig?.model ?? '') ||
    Boolean(requestBody.apiKey.trim()) ||
    requestBody.clearApiKey;
  const candidateHasApiKey = requestBody.clearApiKey
    ? false
    : Boolean(requestBody.apiKey.trim() || state.modelConfig?.hasApiKey);
  const candidateConfigured = Boolean(
    requestBody.baseUrl && requestBody.model && candidateHasApiKey,
  );
  const shouldTest =
    event.submitter?.dataset.action === 'test' ||
    (connectionChanged && candidateConfigured);
  setModelFormBusy(true);
  elements.modelMessage.textContent = shouldTest
    ? '正在验证候选设置；验证成功后才会切换…'
    : '正在安全保存模型设置…';
  elements.modelMessage.classList.remove('success');

  try {
    const config = await requestJson('/api/model-config', {
      method: 'PUT',
      body: {
        ...requestBody,
        testConnection: shouldTest,
      },
    });
    state.modelConfig = config;
    setModelStatus(config);
    populateModelForm(config);
    elements.modelMessage.textContent = config.connectionTest
      ? `连接成功：${config.connectionTest.model}，耗时 ${config.connectionTest.latencyMs} ms；新设置已生效。`
      : config.configured
        ? '模型设置已保存但尚未验证，API Key 不会在页面回显。'
        : '设置已保存，但 API 地址、Key 或模型名尚未完整配置。';
    elements.modelMessage.classList.add('success');

    if (shouldTest) {
      showToast('候选模型设置验证成功并已生效。');
    } else {
      showToast('模型设置已保存。');
      elements.modelDialog.close();
    }
  } catch (error) {
    elements.modelMessage.textContent = error.message;
    elements.modelMessage.classList.remove('success');
    showToast(error.message, 'error');
  } finally {
    setModelFormBusy(false);
  }
}

async function refreshHealth() {
  try {
    const health = await requestJson('/health');
    if (!health.ready) {
      setServiceStatus(
        'offline',
        health.model?.status === 'unconfigured'
          ? '问答模型待配置'
          : '问答服务不可用',
      );
    } else if (health.content?.status === 'stale') {
      setServiceStatus('online', '可用，内容为上一有效版本');
    } else if (health.model?.status === 'unverified') {
      setServiceStatus('online', '可用，模型尚未验证');
    } else {
      setServiceStatus('online', '运行正常');
    }
    if (health.model) {
      const modelConfig = {
        configured: health.model.configured,
        model: health.model.model,
        connection: { status: health.model.status },
      };
      setModelStatus(modelConfig);
    }
    if (health.knowledge) {
      elements.knowledgeCount.textContent = String(
        health.knowledge.documentCount ?? 0,
      );
    }
  } catch {
    setServiceStatus('offline', '无法连接');
  }
}

async function testQuestion(event) {
  event.preventDefault();
  const question = elements.testQuestion.value.trim();
  if (!question) {
    elements.testQuestion.focus();
    return;
  }

  elements.testSubmit.disabled = true;
  elements.testSubmit.textContent = '正在查询…';
  elements.answerCard.className = 'answer-card answer-empty';
  elements.answerText.textContent = '正在调用大语言模型生成回答…';
  elements.answerMeta.hidden = true;

  try {
    const result = await requestJson('/answer', {
      method: 'POST',
      body: { question },
    });
    const answered = result.answerStatus
      ? result.answerStatus === 'answered'
      : result.answered;
    elements.answerCard.className = `answer-card ${
      answered ? 'answer-success' : 'answer-missing'
    }`;
    elements.answerText.textContent = result.answer;
    if (result.model) {
      elements.answerMeta.textContent = `生成模型：${result.model}`;
      elements.answerMeta.hidden = false;
    }
  } catch (error) {
    elements.answerCard.className = 'answer-card answer-missing';
    elements.answerText.textContent = error.message;
    if (error.code === 'MODEL_NOT_CONFIGURED') {
      void openModelSettings();
    }
  } finally {
    elements.testSubmit.disabled = false;
    elements.testSubmit.textContent = '测试回答';
  }
}

elements.search.addEventListener('input', (event) => {
  state.search = event.target.value;
  renderList();
});
elements.addItem.addEventListener('click', addItem);
elements.contentForm.addEventListener('input', syncEditorToState);
elements.saveAll.addEventListener('click', saveContent);
elements.duplicateItem.addEventListener('click', duplicateItem);
elements.moveUp.addEventListener('click', () => moveItem(-1));
elements.moveDown.addEventListener('click', () => moveItem(1));
elements.deleteItem.addEventListener('click', () => {
  const item = currentItem();
  if (!item) {
    return;
  }
  elements.deleteMessage.textContent = `将删除“${item.questions[0] || item.id}”。保存前仍可刷新页面撤销。`;
  elements.deleteDialog.showModal();
});
elements.confirmDelete.addEventListener('click', (event) => {
  event.preventDefault();
  elements.deleteDialog.close();
  deleteCurrentItem();
});
elements.testerForm.addEventListener('submit', testQuestion);
elements.openKnowledgeDialog.addEventListener('click', async () => {
  elements.knowledgeMessage.textContent = '';
  elements.knowledgeMessage.classList.remove('success');
  if (!elements.knowledgeDialog.open) {
    elements.knowledgeDialog.showModal();
  }
  await loadKnowledge();
});
elements.closeKnowledgeDialog.addEventListener('click', () => {
  elements.knowledgeDialog.close();
});
elements.cancelKnowledgeImport.addEventListener('click', () => {
  elements.knowledgeDialog.close();
});
elements.knowledgeFiles.addEventListener('change', () => {
  renderSelectedKnowledgeFiles();
  elements.knowledgeMessage.textContent = '';
  elements.knowledgeMessage.classList.remove('success');
});
for (const input of elements.knowledgeModeInputs) {
  input.addEventListener('change', syncKnowledgeMode);
}
elements.knowledgeForm.addEventListener('submit', importKnowledgeFiles);
elements.refreshKnowledge.addEventListener('click', async () => {
  elements.knowledgeMessage.textContent = '正在刷新…';
  const loaded = await loadKnowledge({ silent: true });
  elements.knowledgeMessage.textContent = loaded ? '列表已刷新。' : '列表刷新失败。';
  elements.knowledgeMessage.classList.toggle('success', loaded);
});
elements.openModelDialog.addEventListener('click', () => {
  void openModelSettings();
});
elements.closeModelDialog.addEventListener('click', () => {
  elements.modelDialog.close();
});
elements.cancelModelSettings.addEventListener('click', () => {
  elements.modelDialog.close();
});
elements.modelForm.addEventListener('submit', saveModelConfig);
elements.logoutAdmin.addEventListener('click', async () => {
  if (
    state.dirty &&
    !window.confirm('当前还有未保存的问答修改，确定退出吗？')
  ) {
    return;
  }
  elements.logoutAdmin.disabled = true;
  try {
    await requestJson('/api/admin/logout', { method: 'POST' });
    state.dirty = false;
    window.location.replace('/');
  } catch (error) {
    elements.logoutAdmin.disabled = false;
    showToast(error.message, 'error');
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void saveContent();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (state.dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});

async function start() {
  await refreshHealth();
  const connected = await loadContent();
  if (connected) {
    await Promise.all([loadModelConfig(), loadKnowledge()]);
  }
  renderSelectedKnowledgeFiles();
  syncKnowledgeMode();
  setInterval(() => void refreshHealth(), 10_000);
}

void start();
