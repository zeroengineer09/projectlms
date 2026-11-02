(() => {
  const $ = selector => document.querySelector(selector);
  const digits = [...document.querySelectorAll('.otp-digit')];
  const recovery = { role: 'student', otpExpiresAt: 0, resendAvailableAt: 0, interval: null, wrongAttempts: 0 };
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function showStep(step) {
    for (const name of ['Request', 'Otp', 'Password', 'Success']) {
      $(`#resetStep${name}`).classList.toggle('hidden', name !== step);
    }
  }

  function loginView() {
    return recovery.role === 'admin' ? 'adminLogin' : recovery.role === 'teacher' ? 'teacherLogin' : 'home';
  }

  function clearTimer() {
    if (recovery.interval) window.clearInterval(recovery.interval);
    recovery.interval = null;
  }

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }

  function updateCountdowns() {
    const now = Date.now();
    const expirySeconds = Math.max(0, Math.ceil((recovery.otpExpiresAt - now) / 1000));
    const resendSeconds = Math.max(0, Math.ceil((recovery.resendAvailableAt - now) / 1000));
    $('#resetExpiryCountdown').textContent = formatTime(expirySeconds);
    $('#resetResendCountdown').textContent = resendSeconds ? `Resend in ${resendSeconds}s` : 'You can request a new code.';
    $('#resetResendButton').disabled = resendSeconds > 0;
    $('#resetVerifyButton').disabled = expirySeconds === 0 || recovery.wrongAttempts >= 5;
    if (expirySeconds === 0 && recovery.wrongAttempts < 5) {
      $('#resetOtpMessage').textContent = 'This code has expired. Request a new code to continue.';
    }
  }

  function startCountdowns() {
    clearTimer();
    recovery.otpExpiresAt = Date.now() + 5 * 60 * 1000;
    recovery.resendAvailableAt = Date.now() + 60 * 1000;
    recovery.wrongAttempts = 0;
    updateCountdowns();
    recovery.interval = window.setInterval(updateCountdowns, 1000);
  }

  function setDigits(value = '') {
    const code = String(value).replace(/\D/g, '').slice(0, digits.length);
    digits.forEach((input, index) => {
      input.value = code[index] || '';
      input.disabled = false;
    });
    const nextEmpty = digits.find(input => !input.value);
    (nextEmpty || digits[digits.length - 1]).focus();
  }

  async function sendRequest(path, payload) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      throw new Error('The recovery service returned an invalid response.');
    }
    if (!response.ok) {
      const error = new Error(data.error || 'Unable to complete password recovery.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function recoveryEndpoint(action) {
    return `/api/password-reset/${recovery.role}/${action}`;
  }

  function openPasswordReset(role) {
    recovery.role = role;
    $('#passwordResetRequestForm').reset();
    $('#resetEmail').value = role === 'student'
      ? $('#studentEmail').value.trim()
      : role === 'teacher'
        ? $('#teacherEmail').value.trim()
        : $('#adminUsername').value.trim();
    $('#passwordResetOtpForm').reset();
    $('#passwordResetForm').reset();
    $('#resetShowPassword').checked = false;
    $('#resetNewPassword').type = 'password';
    $('#resetConfirmPassword').type = 'password';
    $('#resetRequestMessage').textContent = '';
    $('#resetOtpMessage').textContent = '';
    $('#resetPasswordMessage').textContent = '';
    $('#resetServiceMessage').textContent = '';
    $('#resetStrengthBar').style.width = '0%';
    $('#resetStrengthText').textContent = 'Password strength';
    clearTimer();
    showStep('Request');
    show('passwordReset');
  }

  function passwordPolicy() {
    return recovery.role === 'student'
      ? { minimum: 8, description: 'at least 8 characters and include uppercase, lowercase and a number.' }
      : { minimum: 12, description: 'at least 12 characters and include uppercase, lowercase and a number.' };
  }

  function updateStrength() {
    const value = $('#resetNewPassword').value;
    const policy = passwordPolicy();
    const score = [
      value.length >= policy.minimum,
      /[a-z]/.test(value),
      /[A-Z]/.test(value),
      /\d/.test(value),
      value.length >= policy.minimum + 4
    ].filter(Boolean).length;
    const labels = ['Password strength', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong'];
    const bar = $('#resetStrengthBar');
    bar.style.width = `${score * 20}%`;
    bar.dataset.strength = score < 2 ? 'weak' : score < 3 ? 'fair' : score < 4 ? 'good' : 'strong';
    $('#resetStrengthText').textContent = labels[score];
  }

  $('#studentForgotOpen').addEventListener('click', () => openPasswordReset('student'));
  $('#teacherForgotOpen').addEventListener('click', () => openPasswordReset('teacher'));
  $('#adminForgotOpen').addEventListener('click', () => openPasswordReset('admin'));

  $('#passwordResetRequestForm').addEventListener('submit', async event => {
    event.preventDefault();
    const email = $('#resetEmail').value.trim();
    if (!emailPattern.test(email)) {
      $('#resetRequestMessage').textContent = 'Enter a valid email address.';
      return;
    }
    const button = $('#resetSendButton');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    $('#resetServiceMessage').textContent = '';
    $('#resetRequestMessage').textContent = 'Sending verification code…';
    try {
      const result = await sendRequest(recoveryEndpoint('request'), { email });
      $('#resetRequestMessage').textContent = result.message;
      $('#resetStepRequest').classList.add('hidden');
      showStep('Otp');
      setDigits();
      startCountdowns();
    } catch (error) {
      $('#resetRequestMessage').textContent = '';
      $('#resetServiceMessage').textContent = error.message;
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });

  $('#passwordResetOtpForm').addEventListener('submit', async event => {
    event.preventDefault();
    const otp = digits.map(input => input.value).join('');
    if (!/^\d{6}$/.test(otp)) {
      $('#resetOtpMessage').textContent = 'Enter all six digits from the email.';
      return;
    }
    const button = $('#resetVerifyButton');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    $('#resetOtpMessage').textContent = 'Verifying code…';
    $('#resetServiceMessage').textContent = '';
    try {
      await sendRequest(recoveryEndpoint('verify'), {
        email: $('#resetEmail').value.trim(),
        otp
      });
      showStep('Password');
      $('#resetPasswordMessage').textContent = '';
      updateStrength();
      $('#resetNewPassword').focus();
    } catch (error) {
      $('#resetOtpMessage').textContent = error.message;
      if (error.status === 400 && !/too many/i.test(error.message)) {
        recovery.wrongAttempts += 1;
        if (recovery.wrongAttempts >= 5) {
          $('#resetOtpMessage').textContent = 'The maximum number of attempts has been reached. Request a new code.';
          $('#resetVerifyButton').disabled = true;
        }
      }
      setDigits();
      updateCountdowns();
    } finally {
      button.removeAttribute('aria-busy');
      if (Date.now() < recovery.otpExpiresAt && recovery.wrongAttempts < 5) button.disabled = false;
    }
  });

  $('#resetResendButton').addEventListener('click', async () => {
    const button = $('#resetResendButton');
    if (button.disabled) return;
    button.disabled = true;
    $('#resetOtpMessage').textContent = 'Sending a new verification code…';
    $('#resetServiceMessage').textContent = '';
    try {
      const result = await sendRequest(recoveryEndpoint('request'), {
        email: $('#resetEmail').value.trim()
      });
      $('#resetOtpMessage').textContent = result.message;
      setDigits();
      startCountdowns();
    } catch (error) {
      $('#resetOtpMessage').textContent = error.message;
      button.disabled = false;
    }
  });

  $('#resetNewPassword').addEventListener('input', updateStrength);
  $('#resetShowPassword').addEventListener('change', event => {
    const type = event.target.checked ? 'text' : 'password';
    $('#resetNewPassword').type = type;
    $('#resetConfirmPassword').type = type;
  });

  $('#passwordResetForm').addEventListener('submit', async event => {
    event.preventDefault();
    const password = $('#resetNewPassword').value;
    const confirmation = $('#resetConfirmPassword').value;
    const policy = passwordPolicy();
    if (password.length < policy.minimum || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
      $('#resetPasswordMessage').textContent = `Password must be ${policy.description}`;
      return;
    }
    if (password !== confirmation) {
      $('#resetPasswordMessage').textContent = 'Passwords do not match.';
      return;
    }
    const button = $('#resetPasswordButton');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    $('#resetPasswordMessage').textContent = 'Updating your password…';
    $('#resetServiceMessage').textContent = '';
    try {
      const result = await sendRequest(recoveryEndpoint('reset'), {
        email: $('#resetEmail').value.trim(),
        otp: digits.map(input => input.value).join(''),
        newPassword: password
      });
      $('#resetPasswordMessage').textContent = result.message;
      clearTimer();
      showStep('Success');
      $('#resetTitle').focus();
    } catch (error) {
      $('#resetPasswordMessage').textContent = error.message;
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });

  $('#resetBack').addEventListener('click', () => {
    clearTimer();
    show(loginView());
  });
  $('#recoveryReturnLogin').addEventListener('click', () => {
    clearTimer();
    show(loginView());
  });

  digits.forEach((input, index) => {
    input.addEventListener('input', () => {
      const value = input.value.replace(/\D/g, '');
      if (value.length > 1) {
        setDigits(value);
        return;
      }
      input.value = value.slice(-1);
      if (input.value && index < digits.length - 1) digits[index + 1].focus();
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Backspace' && !input.value && index > 0) digits[index - 1].focus();
      if (event.key === 'ArrowLeft' && index > 0) digits[index - 1].focus();
      if (event.key === 'ArrowRight' && index < digits.length - 1) digits[index + 1].focus();
    });
    input.addEventListener('paste', event => {
      const pasted = event.clipboardData?.getData('text') || '';
      if (!/\d/.test(pasted)) return;
      event.preventDefault();
      setDigits(pasted);
    });
  });
})();
