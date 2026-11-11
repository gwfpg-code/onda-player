# Onda Player

Fork di [Xibo Player](https://github.com/xibosignage/electron-player) (Electron, Windows e Linux) con il marchio Onda.
Licenza: **AGPLv3**, come l'originale. Chi riceve il player (i clienti) ha diritto al codice sorgente: questo
repository pubblico, o una copia su richiesta, soddisfa l'obbligo. Le note di copyright di Xibo nei sorgenti restano.

## Differenze rispetto a Xibo Player

| Cosa | Dove |
|---|---|
| Nome, icone, titolo della finestra, schermata di configurazione | `package.json`, `resources/`, `src/renderer/index.html` |
| Schermata di attesa senza logo Xibo, personalizzabile per cliente | `src/main/onda/onda.ts`, `src/main/express.ts`, `src/renderer/src/renderer.ts` |
| Scelta del monitor | `src/main/onda/onda.ts`, `src/main/index.ts` |
| Orari di accensione: spegnimento del monitor fuori orario | `src/main/onda/hours.ts`, `src/main/onda/power.ts`, `src/main/onda/provision.ts`, `snap/snapcraft.yaml` |
| Installer: MSI "Onda Player" con UpgradeCode proprio, .deb, snap `onda-player` | `installer/windows/`, `forge.config.cjs`, `snap/` |
| Build su GitHub senza firma | `.github/workflows/onda-build.yml` (tolti i workflow di Xibo) |

## Provisioning da Onda

Il player non configurato mostra il logo Onda animato e un **codice di 6 caratteri**: si inserisce nella console o nel
pannello di Onda (Schermi › Aggiungi schermo › Onda Player) insieme a sede, nome, formato, monitor, schermata di attesa e PIN.
Il player riceve indirizzo e chiave del motore, si registra e Onda lo abbina e lo autorizza da solo.

- **Indirizzo di Onda:** al primo avvio il player lo chiede (es. `http://192.168.1.10:8080`). Per non digitarlo, prima
  dell'avvio crea `onda.json` nella cartella dati con `{"onda_url": "http://192.168.1.10:8080"}`, oppure imposta la
  variabile d'ambiente `ONDA_URL`.
- **Identità del dispositivo:** chiave hardware + un segreto generato al primo avvio (`onda/identity.json`). Il codice da
  solo non basta a farsi mandare la configurazione.
- **Sincronizzazione:** ogni 5 minuti il player richiama Onda e applica monitor, schermata di attesa, PIN e orari di accensione cambiati dal pannello.
- **Configurazione manuale** (indirizzo e chiave del CMS, come in Xibo): pulsante in basso nella schermata del codice.
- Codice: `src/main/onda/provision.ts`, `src/renderer/src/onda/OndaScreen.ts`. API di Onda: `POST /api/player/hello`,
  `GET /api/player/splash`.

## PIN

Se al provisioning è stato impostato un PIN, servono per: aprire la configurazione, chiudere il player (pulsante **Chiudi**
nella barra che compare muovendo il mouse) e passare alla configurazione manuale. Alt+F4 non chiude il player; lo spegnimento
del sistema sì. Il player conserva solo l'hash del PIN. Il blocco completo del dispositivo (nessun desktop dietro) arriverà
con l'immagine Onda per i mini PC.

## Schermate di attesa

Scelta nel pannello: **logo Onda animato**, **logo del cliente** o **schermo nero**. Vale mentre il player aspetta
l'autorizzazione e quando non c'è nulla in onda: con il player gestito da Onda il layout predefinito del motore
(quello con il logo Xibo) non viene mai mostrato.

## Orari di accensione

Gli orari della sede (settimana con una fascia per giorno e giorni di chiusura, nel fuso della sede) arrivano con la
configurazione di Onda (`config.hours` di `/api/player/hello`) e restano in `onda.json`: valgono anche senza rete.
Ogni 30 secondi il player controlla l'orario (`src/main/onda/hours.ts`, stesse regole di Onda: fascia oltre la
mezzanotte, `on == off` sempre acceso):

- **fuori orario:** toglie il blocco del risparmio energetico (`powerSaveBlocker`) e spegne il monitor; ogni 10 minuti
  lo rispegne se qualcuno l'ha riacceso;
- **alla riaccensione:** riaccende il monitor e rimette il blocco.

| Sistema | Metodo (`src/main/onda/power.ts`) |
|---|---|
| Windows | `SC_MONITORPOWER` con `PostMessage` (PowerShell); per riaccendere anche un piccolo movimento del mouse |
| Linux X11 | `xset dpms force off` / `on` (nello snap c'è `x11-xserver-utils`; con il .deb serve `xset` installato) |
| Linux Wayland | nessun metodo standard: lo spegnimento non viene offerto |

Il player comunica a Onda se sa spegnere il monitor (`capabilities: ["monitor_power"]`) e l'esito dell'ultimo tentativo
(`monitor`): la scheda dello schermo mostra "Monitor spento dal player" oppure "Schermo nero". In ogni caso fuori orario
Onda pubblica uno schermo nero, che resta come rete di sicurezza.

**Da provare su ogni modello di monitor:** alcuni vanno in standby e si riaccendono quando torna il segnale, molti
televisori invece mostrano "nessun segnale" e poi si spengono del tutto, senza riaccendersi da soli.

## Scelta del monitor

In ordine di priorità:

0. dal pannello Onda (pagina dello schermo › Onda Player › Monitor): è il modo normale, il player lo riceve da solo;
1. opzione `--display=2` (numero da 1, da sinistra a destra) oppure `--display=HDMI` (parte dell'etichetta);
2. variabile d'ambiente `ONDA_DISPLAY`;
3. file `onda.json` nella cartella dati del player: `{"display": 2}`.

Cartella dati: Windows `%APPDATA%\onda-player\`, Linux `~/.config/onda-player/` (snap: `~/snap/onda-player/current/.config/onda-player/`).
All'avvio il registro del player elenca i monitor trovati (`[ONDA] Monitor disponibili: 1: … | 2: …`).
Se il monitor viene staccato e ricollegato, il player torna su quello scelto. Dimensione e posizione del profilo del display
(sizeX, offsetX, …) restano valide e sono relative al monitor scelto.

## Aggiornare dall'originale

```bash
git remote add upstream https://github.com/xibosignage/electron-player.git   # una volta
git fetch upstream --tags
git merge v4.0.14            # il tag del nuovo rilascio di Xibo
# conflitti attesi solo nei file della tabella sopra
git tag v4.0.14-onda.1 && git push && git push --tags   # parte la build
```

## Compilare

Come l'originale (`npm ci`, `npm run make`). Su GitHub: tag `v*` oppure Actions › "Onda Player - build" › Run workflow.
Gli installer non sono firmati: Windows SmartScreen chiede conferma al primo avvio. Per toglierlo serve un certificato
di firma del codice (Azure Trusted Signing o un certificato EV).
