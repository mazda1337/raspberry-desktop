import { safeStorage } from 'electron';
import { appStore as store } from './app-store.js';

const LOGIN_KEY = 'saved_login';
const PASSWORD_KEY = 'saved_password';

export type SavedCredentials = { login: string; password: string };

function encryptPassword(password: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(password).toString('base64');
    }
  } catch (e) {
    console.error('Failed to encrypt saved password:', e);
  }
  return 'plain:' + Buffer.from(password, 'utf8').toString('base64');
}

function decryptPassword(stored: string): string {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) {
      if (!safeStorage.isEncryptionAvailable()) return '';
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf8');
    }
  } catch (e) {
    console.error('Failed to decrypt saved password:', e);
  }
  return '';
}

export function writeSavedCredentials(login: string, password: string): void {
  store.set(LOGIN_KEY, login);
  store.set(PASSWORD_KEY, encryptPassword(password));
}

export function readSavedCredentials(): SavedCredentials {
  const storedPassword = String(store.get(PASSWORD_KEY, '') || '');
  let login = String(store.get(LOGIN_KEY, '') || '');
  let password = decryptPassword(storedPassword);

  if (!login || !password) {
    const legacyLogin = String(store.get('login', '') || '');
    const legacyPassword = String(store.get('password', '') || '');
    if (legacyLogin && legacyPassword) {
      writeSavedCredentials(legacyLogin, legacyPassword);
      store.delete('login');
      store.delete('password');
      return { login: legacyLogin, password: legacyPassword };
    }
    return { login, password };
  }

  if (storedPassword.startsWith('plain:') && safeStorage.isEncryptionAvailable()) {
    writeSavedCredentials(login, password);
  }

  return { login, password };
}

/** Persist login/password from the site's Basic token, set only after a successful login. */
export function saveCredentialsFromBasic(base64Credentials: string): void {
  if (!base64Credentials || base64Credentials.length > 10_000) return;

  let decoded = '';
  try {
    decoded = Buffer.from(base64Credentials, 'base64').toString('latin1');
  } catch {
    return;
  }

  const idx = decoded.indexOf(':');
  if (idx <= 0) return;
  const login = decoded.slice(0, idx);
  const password = decoded.slice(idx + 1);
  if (!login || !password) return;

  const current = readSavedCredentials();
  if (current.login === login && current.password === password) return;
  writeSavedCredentials(login, password);
}

/** Runs in the site page: fills the login form and stores credentials after a successful sign-in. */
export function credentialAutofillScript(): string {
  return `
    (function() {
      if (window.__reyoCredentialAutofill) return;
      window.__reyoCredentialAutofill = true;

      var api = window.electronAPI;
      if (!api || !api.getSavedCredentials || !api.saveSavedCredentials) return;

      var creds = { login: '', password: '' };
      var didFocus = false;
      var lastBasic = '';

      function setInputValue(el, value) {
        var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, value);
        else el.value = value;
        var syms = Object.getOwnPropertySymbols(el);
        for (var i = 0; i < syms.length; i++) {
          if (String(syms[i]) === 'Symbol(_assign)' && typeof el[syms[i]] === 'function') {
            el[syms[i]](value);
            break;
          }
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      function tick() {
        var user = document.querySelector('.login-form #username');
        var pass = document.querySelector('.login-form #password');
        if (!user || !pass) {
          didFocus = false;
          return;
        }
        if (!creds.login && !creds.password) return;

        var focused = document.activeElement === user || document.activeElement === pass;
        var needUser = !!creds.login && user.value !== creds.login;
        var needPass = !!creds.password && pass.value !== creds.password;

        if (!needUser && !needPass) {
          if (!didFocus && !focused && user.value && pass.value) {
            var btn = document.querySelector('.login-form button[type="submit"]');
            if (btn && !btn.disabled) {
              btn.focus();
              didFocus = true;
            }
          }
          return;
        }

        if (focused) return;
        if ((user.value && user.value !== creds.login) || (pass.value && pass.value !== creds.password)) return;

        if (needUser) setInputValue(user, creds.login);
        if (needPass) setInputValue(pass, creds.password);
      }

      function capture() {
        try {
          var raw = localStorage.getItem('siteAuth');
          if (!raw) return;
          var parsed = JSON.parse(raw);
          var basic = parsed && parsed.credentials;
          if (!basic || basic === lastBasic) return;
          lastBasic = basic;
          api.saveSavedCredentials(basic).catch(function() {});
          try {
            var decoded = atob(basic);
            var idx = decoded.indexOf(':');
            if (idx > 0) {
              creds = { login: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
            }
          } catch (e) {}
        } catch (e) {}
      }

      api.getSavedCredentials().then(function(saved) {
        if (saved && (saved.login || saved.password)) creds = saved;
        tick();
      }).catch(function() {});

      setInterval(function() {
        capture();
        tick();
      }, 400);
      capture();
    })();
  `;
}
