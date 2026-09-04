const elements = {
  form: document.querySelector('#login-form'),
  kicker: document.querySelector('#login-kicker'),
  title: document.querySelector('#login-title'),
  copy: document.querySelector('#login-copy'),
  passwordLabel: document.querySelector('#password-label'),
  password: document.querySelector('#login-password'),
  confirmField: document.querySelector('#confirm-password-field'),
  confirmPassword: document.querySelector('#confirm-password'),
  message: document.querySelector('#login-message'),
  submit: document.querySelector('#login-submit'),
};

let setupRequired = false;

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setSetupMode(required) {
  setupRequired = required;
  elements.confirmField.hidden = !required;
  elements.confirmPassword.required = required;
  elements.password.autocomplete = required ? 'new-password' : 'current-password';
  elements.kicker.textContent = required ? 'FIRST-TIME SETUP' : 'ADMIN ACCESS';
  elements.title.textContent = required ? '首次设置管理密码' : '进入管理后台';
  elements.passwordLabel.textContent = required ? '新管理密码' : '管理密码';
  elements.copy.textContent = required
    ? '尚未设置管理密码。设置后密码只以加盐哈希形式保存，无法在页面中查看明文。'
    : '请输入管理密码。登录会话在服务重启或过期后失效。';
  elements.submit.textContent = required ? '设置密码并进入' : '登录';
}

async function loadStatus() {
  try {
    const status = await requestJson('/api/admin/status');
    if (status.authenticated) {
      window.location.replace('/');
      return;
    }
    setSetupMode(status.setupRequired);
  } catch (error) {
    elements.message.textContent = error.message;
    elements.submit.disabled = true;
  }
}

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.message.textContent = '';
  if (!elements.form.reportValidity()) {
    return;
  }
  if (
    setupRequired &&
    elements.password.value !== elements.confirmPassword.value
  ) {
    elements.message.textContent = '两次输入的密码不一致。';
    elements.confirmPassword.focus();
    return;
  }

  elements.submit.disabled = true;
  elements.submit.textContent = setupRequired ? '正在安全保存…' : '正在验证…';
  try {
    await requestJson(setupRequired ? '/api/admin/setup' : '/api/admin/login', {
      method: 'POST',
      body: { password: elements.password.value },
    });
    window.location.replace('/');
  } catch (error) {
    elements.message.textContent = error.message;
    elements.password.select();
    elements.submit.disabled = false;
    elements.submit.textContent = setupRequired ? '设置密码并进入' : '登录';
  }
});

void loadStatus();
