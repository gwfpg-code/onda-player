/*
 * Onda Player - schermata del player non configurato e richiesta del PIN (AGPLv3).
 *
 * Al posto di "Use Activation Code / Configure Manually" di Xibo: logo Onda animato, codice da
 * inserire nella console di Onda, stato del collegamento. La configurazione manuale resta come
 * riserva (protetta dal PIN, se impostato).
 */
const onda = (): any => (window as any).ondaAPI;

const CSS = `
#onda-screen { position: fixed; inset: 0; z-index: 9000; background: #0E0D11; color: #F5F4F1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 4vh; font-family: Inter, "DejaVu Sans", system-ui, sans-serif; text-align: center; }
#onda-screen .os-logo { width: min(36vw, 480px); }
#onda-screen .os-code { font: 700 min(12vw, 160px)/1 "DejaVu Sans Mono", monospace; letter-spacing: .12em; color: #C8A15A; }
#onda-screen .os-text { font-size: min(2.6vw, 30px); max-width: 80vw; line-height: 1.4; }
#onda-screen .os-muted { color: #9A97A3; font-size: min(1.6vw, 18px); }
#onda-screen .os-error { color: #F0A090; font-size: min(1.8vw, 20px); max-width: 80vw; }
#onda-screen .os-foot { position: absolute; bottom: 3vh; left: 0; right: 0; display: flex; gap: 12px; justify-content: center; }
#onda-screen button, .onda-pin button { background: transparent; color: #F5F4F1; border: 1px solid #4A4852; border-radius: 8px; padding: 10px 16px;
  font: inherit; font-size: 15px; cursor: pointer; }
#onda-screen button:hover, .onda-pin button:hover { border-color: #C8A15A; }
#onda-screen input, .onda-pin input { background: #17161B; color: #F5F4F1; border: 1px solid #4A4852; border-radius: 8px; padding: 12px 14px;
  font-size: 18px; min-width: min(60vw, 520px); }
.onda-pin { position: fixed; inset: 0; z-index: 9500; background: rgba(14,13,17,.92); display: grid; place-items: center;
  font-family: Inter, "DejaVu Sans", system-ui, sans-serif; color: #F5F4F1; }
.onda-pin form { display: grid; gap: 14px; justify-items: center; }
.onda-pin input { min-width: 0; width: 240px; text-align: center; letter-spacing: .3em; }
`;

const LOGO = `<svg class="os-logo" viewBox="0 0 400 160" xmlns="http://www.w3.org/2000/svg"><style>
.w{stroke-dasharray:160;animation:d 2.4s ease-in-out infinite alternate}@keyframes d{from{stroke-dashoffset:160}to{stroke-dashoffset:0}}</style>
<rect x="20" y="28" width="120" height="104" rx="30" fill="none" stroke="#F5F4F1" stroke-width="11"/>
<path class="w" d="M42 84 C 58 62, 74 62, 80 80 S 102 98, 118 76" fill="none" stroke="#C8A15A" stroke-width="10" stroke-linecap="round"/>
<text x="152" y="122" font-family="Inter, 'DejaVu Sans', Arial, sans-serif" font-weight="700" font-size="100" fill="#F5F4F1">nda</text></svg>`;

function ensureCss() {
  if (!document.getElementById('onda-css')) {
    const st = document.createElement('style');
    st.id = 'onda-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
}

function esc(s: string): string {
  return `${s ?? ''}`.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** Chiede il PIN se impostato. Risolve con il PIN (o '' se non serve), null se annullato o sbagliato 3 volte. */
export async function askPin(title: string): Promise<string | null> {
  if (!onda() || !(await onda().pinRequired())) {
    return '';
  }
  ensureCss();
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'onda-pin';
    box.innerHTML = `<form><b style="font-size:20px">${esc(title)}</b><input type="password" inputmode="numeric" autocomplete="off" maxlength="12">
      <span class="os-err" style="color:#F0A090;min-height:1.2em"></span><div style="display:flex;gap:10px"><button type="button" data-x>Annulla</button>
      <button type="submit">Conferma</button></div></form>`;
    document.body.appendChild(box);
    const input = box.querySelector('input') as HTMLInputElement;
    let tries = 0;
    input.focus();
    const done = (v: string | null) => { box.remove(); resolve(v); };
    (box.querySelector('[data-x]') as HTMLElement).onclick = () => done(null);
    (box.querySelector('form') as HTMLFormElement).onsubmit = async (e) => {
      e.preventDefault();
      if (await onda().checkPin(input.value)) {
        done(input.value);
        return;
      }
      tries += 1;
      (box.querySelector('.os-err') as HTMLElement).textContent = tries >= 3 ? 'PIN errato.' : 'PIN errato, riprova.';
      input.value = '';
      if (tries >= 3) {
        setTimeout(() => done(null), 1200);
      }
    };
  });
}

/**
 * Schermata del player non configurato. Ritorna quando Onda ha mandato la configurazione
 * (con cmsUrl, cmsKey e displayName) oppure quando si sceglie la configurazione manuale (null).
 */
export function runOndaScreen(): Promise<{ cmsUrl: string; cmsKey: string; displayName: string } | null> {
  ensureCss();
  const el = document.createElement('div');
  el.id = 'onda-screen';
  document.body.appendChild(el);
  let timer: number | undefined;

  return new Promise((resolve) => {
    const finish = (v: any) => { if (timer) { clearTimeout(timer); } el.remove(); resolve(v); };

    const foot = `<div class="os-foot"><button type="button" data-identify>Identifica i monitor</button>
      <button type="button" data-manual>Configurazione manuale</button></div>`;

    const bind = () => {
      const id = el.querySelector('[data-identify]') as HTMLElement | null;
      if (id) { id.onclick = () => onda().identify(); }
      const man = el.querySelector('[data-manual]') as HTMLElement | null;
      if (man) {
        man.onclick = async () => {
          if ((await askPin('PIN per la configurazione manuale')) !== null) {
            finish(null);
          }
        };
      }
    };

    const showUrlForm = (error = '') => {
      el.innerHTML = `${LOGO}<div class="os-text">Indirizzo di Onda</div>
        <form data-url style="display:grid;gap:12px;justify-items:center"><input name="url" placeholder="http://192.168.1.10:8080" autocomplete="off">
        <button type="submit">Collega</button></form>
        <div class="os-muted">È l'indirizzo del pannello Onda raggiungibile da questo dispositivo.</div>
        ${error ? `<div class="os-error">${esc(error)}</div>` : ''}${foot}`;
      bind();
      (el.querySelector('form[data-url]') as HTMLFormElement).onsubmit = async (e) => {
        e.preventDefault();
        const r = await onda().setUrl((el.querySelector('input[name=url]') as HTMLInputElement).value);
        if (!r.ok) { showUrlForm(r.error); return; }
        tick();
      };
    };

    const tick = async () => {
      const r = await onda().hello();
      if (r.status === 'no-url') {
        showUrlForm();
        return;
      }
      if (r.status === 'configured' && r.config && r.config.cms_url && r.config.cms_key) {
        el.innerHTML = `${LOGO}<div class="os-text">Configurazione ricevuta${r.config.tenant ? ` per <b>${esc(r.config.tenant)}</b>` : ''}:<br>collegamento in corso…</div>`;
        setTimeout(() => finish({ cmsUrl: r.config.cms_url, cmsKey: r.config.cms_key, displayName: r.config.display_name }), 1500);
        return;
      }
      if (r.status === 'pending' && r.code) {
        const code = `${r.code}`;
        el.innerHTML = `${LOGO}<div class="os-code">${esc(code.slice(0, 3))} ${esc(code.slice(3))}</div>
          <div class="os-text">Inserisci questo codice in Onda<br><span class="os-muted">Schermi › Aggiungi schermo › Onda Player</span></div>
          <div class="os-muted">Collegato a ${esc(r.url)} · in attesa della configurazione</div>${foot}`;
      } else {
        el.innerHTML = `${LOGO}<div class="os-error">${esc(r.error || 'Onda non risponde')}</div>
          <div class="os-muted">Nuovo tentativo tra pochi secondi…</div>${foot}`;
      }
      bind();
      timer = window.setTimeout(tick, Math.max(5, Math.min(60, r.poll_seconds || 10)) * 1000);
    };
    tick();
  });
}
