/*
FILE:      tests/action.test.js
CREATED:   2026-11-16 21:10 +03
TASK:      job 61, int-auth0
AUTHOR:    M Alhassoun
WHAT:      Unit tests for the Auth0 custom phone provider Action: SMS vs voice, country allowlist, test vs live mode,
           kwtSMS errors (drop) vs network errors (retry), missing secrets, Arabic digits, no code in logs.
WHY:       The Action runs inside Auth0, where a mistake is only visible in the tenant logs. No network here: the
           KwtSMS class is replaced; cleanMessage and maskPhone are the real library functions.
USAGE:     npm test
*/
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const real = require('kwtsms');

let calls;
let answer;
class FakeKwtSMS {
  constructor(user, pass, opts) {
    if (!user || !pass) throw new Error('username and password are required');
    this.opts = opts;
  }
  async send(to, text) {
    calls.push({ to, text, opts: this.opts });
    if (answer instanceof Error) throw answer;
    return answer;
  }
}
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'kwtsms') return { ...real, KwtSMS: FakeKwtSMS };
  return origLoad.call(this, req, ...rest);
};
const { onExecuteCustomPhoneProvider } = require('../src/action.js');

const SECRETS = { KWTSMS_USERNAME: 'u', KWTSMS_PASSWORD: 'p', KWTSMS_SENDER_ID: 'MYSENDER', KWTSMS_LIVE: '1' };

async function run(notification = {}, secrets = SECRETS) {
  const api = { dropped: null, retried: null, notification: {} };
  api.notification.drop = (r) => (api.dropped = r);
  api.notification.retry = (r) => (api.retried = r);
  const event = {
    secrets,
    notification: {
      message_type: 'otp_verify',
      delivery_method: 'text',
      recipient: '+96550000000',
      code: '123456',
      as_text: 'Your verification code is: 123456',
      locale: 'en',
      ...notification,
    },
  };
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await onExecuteCustomPhoneProvider(event, api);
  } finally {
    console.log = orig;
  }
  return { api, logs };
}

test.beforeEach(() => {
  calls = [];
  answer = { result: 'OK', 'msg-id': 'abc123' };
});

test('live: sends the Auth0 text to the number, digits only', async () => {
  const { api, logs } = await run();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, '96550000000');
  assert.equal(calls[0].text, 'Your verification code is: 123456');
  assert.equal(calls[0].opts.testMode, false);
  assert.equal(calls[0].opts.senderId, 'MYSENDER');
  assert.equal(api.dropped, null);
  assert.equal(api.retried, null);
  assert.match(logs.join(), /msg-id abc123/);
});

test('test mode unless KWTSMS_LIVE is 1', async () => {
  const { logs } = await run({}, { ...SECRETS, KWTSMS_LIVE: 'true' });
  assert.equal(calls[0].opts.testMode, true);
  assert.match(logs.join(), /TEST MODE/);
});

test('voice: dropped, nothing sent', async () => {
  const { api } = await run({ delivery_method: 'voice' });
  assert.equal(calls.length, 0);
  assert.match(api.dropped, /SMS only/);
});

test('number outside the allowed countries: dropped, nothing sent', async () => {
  const { api } = await run({ recipient: '+12025550100' });
  assert.equal(calls.length, 0);
  assert.match(api.dropped, /outside KWTSMS_ALLOWED_COUNTRIES/);
});

test('KWTSMS_ALLOWED_COUNTRIES adds countries', async () => {
  await run({ recipient: '+971500000000' }, { ...SECRETS, KWTSMS_ALLOWED_COUNTRIES: '965, 971' });
  assert.equal(calls[0].to, '971500000000');
});

test('Arabic-Indic digits and 00 prefix are normalized', async () => {
  await run({ recipient: '٠٠٩٦٥٥٠٠٠٠٠٠٠' });
  assert.equal(calls[0].to, '96550000000');
});

test('kwtSMS ERR code: dropped with the code (no retry storm)', async () => {
  answer = { result: 'ERROR', code: 'ERR010', description: 'Zero balance' };
  const { api } = await run();
  assert.match(api.dropped, /ERR010/);
  assert.equal(api.retried, null);
});

test('network error: retried', async () => {
  answer = { result: 'ERROR', code: 'NETWORK', description: 'ENOTFOUND' };
  const { api } = await run();
  assert.match(api.retried, /not reachable/);
});

test('thrown error: retried', async () => {
  answer = new TypeError('fetch failed');
  const { api } = await run();
  assert.match(api.retried, /TypeError/);
});

test('missing credentials: dropped with a clear reason', async () => {
  const { api } = await run({}, { KWTSMS_LIVE: '1' });
  assert.match(api.dropped, /KWTSMS_USERNAME/);
  assert.equal(calls.length, 0);
});

test('emoji and hidden characters are cleaned, Arabic kept', async () => {
  await run({ as_text: 'رمز التحقق 123456 ​😀' });
  assert.equal(calls[0].text.includes('​'), false);
  assert.equal(calls[0].text.includes('😀'), false);
  assert.match(calls[0].text, /رمز التحقق 123456/);
});

test('logs never hold the code or the full number', async () => {
  const { logs } = await run();
  assert.equal(logs.join().includes('123456'), false);
  assert.equal(logs.join().includes('96550000000'), false);
});
