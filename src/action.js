/**
 * kwtSMS custom phone provider for Auth0 (Action, trigger: custom-phone-provider).
 *
 * Paste this code in Auth0: Branding, Phone Provider, Custom. Add the dependency kwtsms (version 0.6.0)
 * and these secrets:
 *   KWTSMS_USERNAME            your kwtSMS API username (not your mobile number)
 *   KWTSMS_PASSWORD            your kwtSMS API password
 *   KWTSMS_SENDER_ID           your own approved Sender ID (KWT-SMS is for tests only)
 *   KWTSMS_LIVE                1 = deliver. Anything else = test mode: queued in kwtSMS, NOT delivered
 *   KWTSMS_ALLOWED_COUNTRIES   optional, country codes allowed to receive SMS, comma separated. Default 965
 *
 * The SMS text is the one Auth0 builds from your phone message templates (Branding, Phone Message Templates).
 * Voice messages are not sent: kwtSMS sends SMS only. The code is never logged.
 * https://github.com/kwtsms/kwtsms-auth0
 *
 * 2026-11-16 21:05 +03: first version (kwtsms-auth0 0.1.0).
 */
exports.onExecuteCustomPhoneProvider = async (event, api) => {
  const { KwtSMS, cleanMessage, maskPhone } = require('kwtsms');
  const n = event.notification || {};
  const s = event.secrets || {};

  if (n.delivery_method && n.delivery_method !== 'text') {
    api.notification.drop('kwtSMS sends SMS only, not voice messages');
    return;
  }

  // Arabic and Persian digits to Latin, then digits only; drop the international 00 prefix
  const to = String(n.recipient || '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '')
    .replace(/^00/, '');
  const allowed = String(s.KWTSMS_ALLOWED_COUNTRIES || '965').split(',').map((c) => c.trim()).filter(Boolean);
  if (!allowed.some((c) => to.startsWith(c))) {
    api.notification.drop(`kwtSMS: number ${maskPhone(to)} is outside KWTSMS_ALLOWED_COUNTRIES`);
    return;
  }

  const text = cleanMessage(String(n.as_text || ''));
  if (!text.trim()) {
    api.notification.drop('kwtSMS: empty message');
    return;
  }

  const live = s.KWTSMS_LIVE === '1';
  let sms;
  try {
    sms = new KwtSMS(s.KWTSMS_USERNAME, s.KWTSMS_PASSWORD, {
      senderId: s.KWTSMS_SENDER_ID || 'KWT-SMS',
      testMode: !live,
      logFile: '', // the library log would hold the message text, which holds the code
      appName: 'kwtsms-auth0/0.1.0',
    });
  } catch (e) {
    api.notification.drop('kwtSMS: set the secrets KWTSMS_USERNAME and KWTSMS_PASSWORD');
    return;
  }

  let r;
  try {
    r = await sms.send(to, text);
  } catch (e) {
    api.notification.retry(`kwtSMS not reachable: ${e && e.name ? e.name : 'Error'}`);
    return;
  }
  if (r.result === 'OK') {
    console.log(`kwtSMS ${live ? 'sent' : 'TEST MODE, queued not delivered'}: msg-id ${r['msg-id']} to ${maskPhone(to)}`);
    return;
  }
  if (r.code === 'NETWORK') {
    api.notification.retry('kwtSMS not reachable, Auth0 retries');
    return;
  }
  api.notification.drop(`kwtSMS ${r.code || 'ERROR'}: ${r.description || ''}`.trim());
};
