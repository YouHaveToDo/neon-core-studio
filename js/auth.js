/* ARCANE LEDGER — login/signup screen logic (plan.md 4.1, spec §4.1-§4.2).
 *
 * Self-contained module, same shape as js/deck.js (own DOM cache + state +
 * event wiring, reached only via Screens.show('screen-login')). Does not
 * know about the main menu -- on a successful login/signup it hands the
 * server's account object to whatever `onAuthenticated` callback main.js
 * registered via Auth.init(), the same decoupling deck.js uses for its own
 * screen (nothing in this file assumes what happens after auth succeeds).
 *
 * Client-side validation here is a UX nicety only (instant feedback,
 * matching spec copy) -- server/src/lib/validators.js is the actual
 * enforcement (server/src/routes/auth.js), never trust the client. The
 * rules and exact Korean copy below are intentionally duplicated from that
 * file so behavior matches exactly; if the server's rules ever change,
 * this file needs the same update.
 */
const Auth = (() => {
  // Mirrors server/src/lib/validators.js exactly.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function isValidEmail(v) { return typeof v === 'string' && v.length > 0 && v.length <= 320 && EMAIL_RE.test(v); }
  function isValidPassword(v) { return typeof v === 'string' && v.length >= 8; }
  function isValidDisplayName(v) {
    const t = typeof v === 'string' ? v.trim() : '';
    return t.length >= 2 && t.length <= 16;
  }

  // Exact copy from spec §4.1-§4.2 / server/src/routes/auth.js -- kept as
  // named constants rather than inlined so the "one unified login message"
  // requirement (spec §4.2) is structurally impossible to accidentally
  // fork into two different strings.
  const MSG = {
    emailFormat: '올바른 이메일 형식이 아닙니다',
    passwordLength: '비밀번호는 최소 8자 이상이어야 합니다',
    passwordMismatch: '비밀번호가 일치하지 않습니다',
    displayNameLength: '표시 이름은 2~16자여야 합니다',
    loginGeneric: '이메일 또는 비밀번호가 올바르지 않습니다',
  };

  const el = {};
  let callbacks = { onAuthenticated: () => {}, onShowHowto: () => {} };
  let submitting = false;

  function cache() {
    el.screen = document.getElementById('screen-login');
    el.tabLogin = document.getElementById('auth-tab-login');
    el.tabSignup = document.getElementById('auth-tab-signup');

    el.formLogin = document.getElementById('auth-form-login');
    el.loginEmailWrap = document.getElementById('login-email-wrap');
    el.loginEmail = document.getElementById('login-email');
    el.loginPasswordWrap = document.getElementById('login-password-wrap');
    el.loginPassword = document.getElementById('login-password');
    el.loginError = document.getElementById('login-error');
    el.loginErrorText = document.getElementById('login-error-text');
    el.loginSubmit = document.getElementById('login-submit');

    el.formSignup = document.getElementById('auth-form-signup');
    el.signupEmailWrap = document.getElementById('signup-email-wrap');
    el.signupEmail = document.getElementById('signup-email');
    el.signupEmailError = document.getElementById('signup-email-error');
    el.signupPasswordWrap = document.getElementById('signup-password-wrap');
    el.signupPassword = document.getElementById('signup-password');
    el.signupPasswordError = document.getElementById('signup-password-error');
    el.signupConfirmWrap = document.getElementById('signup-confirm-wrap');
    el.signupConfirm = document.getElementById('signup-confirm');
    el.signupConfirmError = document.getElementById('signup-confirm-error');
    el.signupNameWrap = document.getElementById('signup-name-wrap');
    el.signupName = document.getElementById('signup-name');
    el.signupNameError = document.getElementById('signup-name-error');
    el.signupSubmit = document.getElementById('signup-submit');

    el.howtoLink = document.getElementById('auth-howto-link');
  }

  // ---- tabs -----------------------------------------------------------
  function showTab(tab) {
    el.tabLogin.classList.toggle('active', tab === 'login');
    el.tabSignup.classList.toggle('active', tab === 'signup');
    el.formLogin.classList.toggle('hidden', tab !== 'login');
    el.formSignup.classList.toggle('hidden', tab !== 'signup');
  }

  // ---- login ------------------------------------------------------------
  function setLoginError(message) {
    const invalid = !!message;
    el.loginEmailWrap.classList.toggle('field-invalid', invalid);
    el.loginPasswordWrap.classList.toggle('field-invalid', invalid);
    el.loginError.classList.toggle('hidden', !invalid);
    el.loginErrorText.textContent = message || '';
  }

  async function submitLogin(e) {
    e.preventDefault();
    if (submitting) return;
    const email = el.loginEmail.value;
    const password = el.loginPassword.value;

    // spec §4.2: login failure is a single unified message, never split by
    // field or by reason -- so even a client-side "you left this blank"
    // check must not say anything more specific than the real server error.
    if (!email || !password) {
      setLoginError(MSG.loginGeneric);
      return;
    }

    submitting = true;
    el.loginSubmit.disabled = true;
    try {
      const result = await API.auth.login({ email, password });
      setLoginError(null);
      callbacks.onAuthenticated(result.account);
    } catch (err) {
      const message = (err instanceof API.ApiError && err.data && err.data.error) || MSG.loginGeneric;
      setLoginError(message);
    } finally {
      submitting = false;
      el.loginSubmit.disabled = false;
    }
  }

  // ---- signup -----------------------------------------------------------
  // Same branch order as server/src/routes/auth.js's signup handler: a
  // too-short password suppresses the separate confirm-mismatch error
  // (matching it exactly, not just "close enough") so a signup that fails
  // both client- and server-side always shows the identical single error
  // per field.
  function validateSignupFields(fields) {
    const errors = {};
    if (!isValidEmail(fields.email)) errors.email = MSG.emailFormat;
    if (!isValidPassword(fields.password)) {
      errors.password = MSG.passwordLength;
    } else if (fields.password !== fields.confirmPassword) {
      errors.confirmPassword = MSG.passwordMismatch;
    }
    if (!isValidDisplayName(fields.displayName)) errors.displayName = MSG.displayNameLength;
    return errors;
  }

  function setFieldError(wrapEl, errorEl, message) {
    wrapEl.classList.toggle('field-invalid', !!message);
    errorEl.classList.toggle('hidden', !message);
    errorEl.querySelector('span').textContent = message || '';
  }

  function renderSignupErrors(errors) {
    setFieldError(el.signupEmailWrap, el.signupEmailError, errors.email);
    setFieldError(el.signupPasswordWrap, el.signupPasswordError, errors.password);
    setFieldError(el.signupConfirmWrap, el.signupConfirmError, errors.confirmPassword);
    setFieldError(el.signupNameWrap, el.signupNameError, errors.displayName);
  }

  async function submitSignup(e) {
    e.preventDefault();
    if (submitting) return;
    const fields = {
      email: el.signupEmail.value,
      password: el.signupPassword.value,
      confirmPassword: el.signupConfirm.value,
      displayName: el.signupName.value,
    };

    const clientErrors = validateSignupFields(fields);
    renderSignupErrors(clientErrors);
    if (Object.keys(clientErrors).length > 0) return;

    submitting = true;
    el.signupSubmit.disabled = true;
    try {
      // Auto-login on success (spec §4.1): the server already set the
      // session cookie in this same response, so there is no separate
      // login step -- go straight to the logged-in view.
      const result = await API.auth.signup(fields);
      callbacks.onAuthenticated(result.account);
    } catch (err) {
      if (err instanceof API.ApiError && err.data && err.data.fieldErrors) {
        renderSignupErrors(err.data.fieldErrors);
      } else {
        // Server/network failure with no field-level detail (e.g. 500) --
        // this screen has no dedicated form-level error slot (mockup only
        // shows per-field errors), so surface it on the email field, the
        // top of the form, rather than silently doing nothing.
        renderSignupErrors({ email: err.message });
      }
    } finally {
      submitting = false;
      el.signupSubmit.disabled = false;
    }
  }

  // ---- lifecycle ----------------------------------------------------------
  // Shown fresh every time (after logout, or on initial load when the
  // session check fails) -- clears both forms rather than leaving a
  // previous session's typed password sitting in the DOM.
  function show() {
    el.formLogin.reset();
    el.formSignup.reset();
    setLoginError(null);
    renderSignupErrors({});
    showTab('login');
    Screens.show('screen-login');
  }

  function init(opts) {
    callbacks = Object.assign({ onAuthenticated: () => {}, onShowHowto: () => {} }, opts);
    cache();
    el.tabLogin.addEventListener('click', () => showTab('login'));
    el.tabSignup.addEventListener('click', () => showTab('signup'));
    el.formLogin.addEventListener('submit', submitLogin);
    el.formSignup.addEventListener('submit', submitSignup);
    el.howtoLink.addEventListener('click', (e) => {
      e.preventDefault();
      callbacks.onShowHowto();
    });
  }

  return { init, show };
})();
