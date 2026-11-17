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
| Server locale (porta 9696) solo su `127.0.0.1` e `::1`, non raggiungibile dalla LAN | `src/main/express.ts` |
| Eventi e reazioni: collegamento con Onda (WebSocket), esecutore delle reazioni, webhook locale | `src/main/onda/events.ts`, `src/main/onda/onda-reactions.js`, `src/main/onda/localwebhook.ts` |
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
  `GET /api/player/splash` (dalla onda.7 chiave hardware e segreto negli header `X-Onda-Hardware-Key` e
  `X-Onda-Secret`, non più nell'indirizzo: lì il segreto finiva nei log di accesso di Onda).

## Eventi e reazioni

Con la funzione Eventi attiva per il cliente, il player apre una WebSocket verso Onda (`<onda>/api/player/ws`,
protocollo `onda-ws-1`, descritto in `backend/app/events/devices.py` di Onda): nessuna porta aperta sul dispositivo.
Si presenta con chiave hardware e segreto, come per il provisioning, riceve il pacchetto regole del suo schermo
(`onda-rules-1`, aggiornato entro 30 secondi da ogni modifica) e gli eventi che lo riguardano.

- **Decisione:** `src/main/onda/onda-reactions.js`, copia **identica** di `backend/app/static/js/onda-reactions.js` di
  Onda (lo stesso codice dell'anteprima del pannello). Quando cambia in Onda va ricopiato qui.
- **Tutto schermo:** il layout del loop pubblicato da Onda contiene una zona trasparente sopra il loop, il cassetto
  con i contenuti delle reazioni e un'azione per contenuto con un codice trigger (`onda-r<regola>-<n>`). Il player
  attiva i codici in sequenza, come `POST /trigger` ma dall'interno: il contenuto compare a tutto schermo e il loop
  riprende da dove era.
- **Registro:** il player riferisce l'esito (eseguito, pausa, ignorato, scartato) e l'inizio e la fine della reazione:
  in Onda › Eventi › Registro l'esecutore risulta "Onda Player", e Onda manda `reaction.started` / `reaction.ended`
  alle destinazioni.
- **Collegamento:** ping ogni 30 secondi, nuovo tentativo con attese crescenti (da 2 a 60 secondi). Registro del
  player: righe `[ONDA] Eventi: …`.
- **Fine della reazione:** allo scadere della durata, con "Annulla" o quando un'altra la sostituisce, se il contenuto
  è ancora in corso il player attiva `onda-stop`: un contenuto vuoto di 1 secondo nel cassetto prende il suo posto e
  torna il loop. "Ricomincia" fa prima lo stop e poi riparte dal primo contenuto (il renderer ignora un contenuto del
  cassetto già in coda). Serve il layout pubblicato da Onda 0.18.0 o successiva.
- **PIP:** la regola sceglie la posizione (angoli, terzo inferiore, metà destra o sinistra); il layout del loop ha
  una zona trasparente per ogni posizione usata, con il suo codice di stop (`onda-stop-<posizione>`, nel pacchetto
  come `stop_trigger`). Il loop continua sotto.
- **Contenuto obbligatorio della Direzione:** Onda manda nel pacchetto i widget del loop e quelli obbligatori
  (`loop.mandatory_widgets`); il renderer segnala ogni `widgetStart`/`widgetEnd` al processo principale (IPC
  `onda-widget`). Mentre è in onda un contenuto obbligatorio, una reazione senza "Può interrompere i contenuti
  obbligatori" resta in attesa (nel registro "In attesa") e parte quando nel loop arriva un contenuto non obbligatorio
  ("Eseguito"), o viene scartata dopo 5 minuti: con un loop fatto solo di contenuti obbligatori non parte mai. Una reazione già in corso non viene chiusa se sotto parte un contenuto obbligatorio.
- **Senza rete:** l'ultimo pacchetto regole resta in `onda/rules.json` e vale anche se all'avvio Onda non risponde;
  esiti e reazioni restano in coda (fino a 500) e partono quando il collegamento torna.
- **Limiti:** il contenuto obbligatorio della Direzione non è ancora riconosciuto.

### Webhook locale (rete della sede)

Per sensori, pulsanti e regia in sede, che devono reagire subito anche senza Internet. **Spento di default**: si accende
nella scheda dello schermo in Onda (Onda Player › Webhook locale nella rete della sede, porta predefinita **9697**) e
il player lo riceve entro 30 secondi con il pacchetto regole (`local_webhook`).

```
POST http://<indirizzo del player>:9697/api/events/v1/<id della fonte>
Authorization: Bearer <token della fonte>
{"id": "evt-0001", "type": "button.pressed", "data": {"pulsante": 1}}
```

- Stesso corpo e stesso token del webhook di Onda; risposte: 202 accettato (con l'esito della reazione), 200 doppione,
  400 dati non validi, 401 fonte o token sbagliati, 403 fonte revocata / indirizzo non ammesso / tipo non ammesso /
  altro schermo, 413 oltre 4 KB, 429 troppe richieste.
- Accetta solo gli **indirizzi ammessi** dalla fonte (Onda › Eventi › Fonti: IP o reti come `192.168.1.0/24`); lista
  vuota = nessuno. Le fonti con **firma HMAC** non sono accettate: il player conosce solo l'impronta del token.
- La reazione parte subito con le regole in memoria; poi il player la riferisce a Onda (`local_event`): nel registro
  l'evento risulta "rete locale", con l'esecutore "Onda Player"; le regole "solo uscita" le esegue Onda.
- Il server interno della porta 9696 (`/trigger`) resta solo su localhost.
- **Windows:** il firewall blocca le connessioni in entrata. Una volta, da un prompt come amministratore:
  `netsh advfirewall firewall add rule name="Onda Player - webhook locale" dir=in action=allow protocol=TCP localport=9697 profile=private,domain`
  (con un'altra porta cambia `localport`). Su Linux serve solo se il firewall è attivo (`ufw allow 9697/tcp`).

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

## Server locale (porta 9696)

Il player serve layout, contenuti e pacchetti HTML al proprio renderer su `http://localhost:9696`. Nel player Xibo
originale il server ascolta su tutte le interfacce: chiunque nella rete della sede poteva chiamare `POST /trigger` e
far partire le azioni interattive, senza credenziali. Onda Player ascolta solo su `127.0.0.1` e, se il sistema ha
IPv6, su `::1`: dalla LAN la porta risulta chiusa.

Conseguenza: il "webhook del player" di Xibo non si può chiamare da un altro dispositivo. Gli eventi dalla rete della
sede arriveranno con la funzione Eventi e reazioni di Onda, su un endpoint separato con token e indirizzi ammessi.

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
