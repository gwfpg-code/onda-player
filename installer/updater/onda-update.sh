#!/bin/sh
# Onda Player - aggiornatore automatico per Linux (AGPLv3, come il progetto originale).
#
# Lo avvia systemd come root (onda-player-update.path → .service, unità scritte dal pacchetto .deb di Onda) quando
# il player lascia un aggiornamento in /var/lib/onda-player/update:
#   package.deb, manifest.sig (firma RSA SHA-256 in base64), manifest.json (ultimo, fa partire l'aggiornatore).
# La cartella è scrivibile da tutti, quindi conta solo la firma: copio i file in una cartella di root, verifico firma
# (chiave pubblica /etc/onda-player/update.pem), scadenza e impronta, poi installo con apt. Il player resta acceso
# durante l'installazione e si riavvia da solo quando legge status.json ("installed").
# Registro: /var/log/onda-player-update.log
set -u
STAGE=/var/lib/onda-player/update
KEY=/etc/onda-player/update.pem
LOG=/var/log/onda-player-update.log
VERSION=""
umask 022
WORK=$(mktemp -d /run/onda-player-update.XXXXXX) || exit 1
trap 'rm -rf "$WORK"' EXIT

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

status() {
  # scrivo in una cartella mia e poi sposto: un collegamento lasciato al posto di status.json viene sostituito
  printf '{"version": "%s", "state": "%s", "detail": "%s", "at": "%s"}\n' \
    "$VERSION" "$1" "$(printf '%s' "$2" | tr -d '"\\\n' | cut -c1-200)" "$(date -u +%FT%TZ)" > "$WORK/status.json"
  chmod 644 "$WORK/status.json"
  mv -f "$WORK/status.json" "$STAGE/status.json"
}

clear_stage() { rm -f "$STAGE/manifest.json" "$STAGE/manifest.sig" "$STAGE/package.deb"; }

fail() { log "Aggiornamento scartato: $1"; clear_stage; status failed "$1"; exit 0; }

[ -f "$STAGE/manifest.json" ] || exit 0
[ -L "$STAGE" ] && { log "La cartella di attesa è un collegamento"; exit 0; }
for f in manifest.json manifest.sig package.deb; do
  [ -f "$STAGE/$f" ] && [ ! -L "$STAGE/$f" ] || fail "manca $f"
  cp "$STAGE/$f" "$WORK/$f" || fail "copia di $f non riuscita"
done
clear_stage

[ -f "$KEY" ] || fail "chiave pubblica di Onda assente: installa il player con un pacchetto scaricato da Onda"
base64 -d "$WORK/manifest.sig" > "$WORK/sig.bin" 2>/dev/null || fail "firma illeggibile"
openssl dgst -sha256 -verify "$KEY" -signature "$WORK/sig.bin" "$WORK/manifest.json" >/dev/null 2>&1 \
  || fail "firma non valida: pacchetto scartato"

M="$WORK/manifest.json"
val() { sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p" "$M"; }
VERSION=$(val version)
[ "$(val schema)" = "onda-update-1" ] && [ "$(val kind)" = "deb" ] || fail "manifesto di un altro tipo"
EXP=$(date -u -d "$(val expires_at)" +%s 2>/dev/null) || fail "scadenza illeggibile"
[ "$EXP" -ge "$(date -u +%s)" ] || fail "manifesto scaduto"
[ "$(stat -c %s "$WORK/package.deb")" = "$(val size)" ] || fail "dimensione del pacchetto diversa"
[ "$(sha256sum "$WORK/package.deb" | cut -d' ' -f1)" = "$(val sha256)" ] || fail "impronta del pacchetto diversa"

log "Installo Onda Player $VERSION"
status installing ""
if DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$WORK/package.deb" >> "$LOG" 2>&1; then
  log "Installato $VERSION"
  status installed ""
else
  log "apt-get non riuscito"
  status failed "installazione non riuscita (apt-get): vedi $LOG"
fi
exit 0
