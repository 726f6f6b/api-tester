const DEFAULT = 'http://localhost:4000';
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get('testerUrl', ({ testerUrl }) => { $('url').value = testerUrl || DEFAULT; });

$('save').onclick = async () => {
  let v = $('url').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  let origin;
  try { origin = new URL(v).origin; } catch (e) { $('status').textContent = 'That is not a valid URL.'; return; }

  await chrome.storage.sync.set({ testerUrl: v });
  // permissions.request must run in a user gesture (this click).
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [origin + '/*'] }); } catch (e) {}
  $('status').style.color = granted ? '#1a7f37' : '#9a6700';
  $('status').textContent = granted
    ? 'Saved. One-click send enabled for ' + origin
    : 'Saved — but without permission, captures will only copy to the clipboard. Click Save again to grant.';
};
