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
| Installer: MSI "Onda Player" con UpgradeCode proprio, .deb, snap `onda-player` | `installer/windows/`, `forge.config.cjs`, `snap/` |
| Build su GitHub senza firma | `.github/workflows/onda-build.yml` (tolti i workflow di Xibo) |

## Scelta del monitor

In ordine di priorità:

1. opzione `--display=2` (numero da 1, da sinistra a destra) oppure `--display=HDMI` (parte dell'etichetta);
2. variabile d'ambiente `ONDA_DISPLAY`;
3. file `onda.json` nella cartella dati del player: `{"display": 2}`.

Cartella dati: Windows `%APPDATA%\onda-player\`, Linux `~/.config/onda-player/` (snap: `~/snap/onda-player/current/.config/onda-player/`).
All'avvio il registro del player elenca i monitor trovati (`[ONDA] Monitor disponibili: 1: … | 2: …`).
Se il monitor viene staccato e ricollegato, il player torna su quello scelto. Dimensione e posizione del profilo del display
(sizeX, offsetX, …) restano valide e sono relative al monitor scelto.

## Schermata di attesa

Il player mostra `onda/splash.png` (o `.jpg`/`.webp`) dalla cartella dati, se c'è; altrimenti il logo Onda incluso.
L'agente Onda la copierà con il logo del cliente.

Da sapere: quando non c'è nulla in programma, il player mostra il **layout predefinito del CMS**. Quello di Xibo
contiene il logo Xibo: va sostituito nel motore (Onda lo farà dai Controlli del motore).

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
