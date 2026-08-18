#!/usr/bin/env bash
set -Eeuo pipefail

# railway-entrypoint.sh
#
# Starts the Multilogin launcher, keeps its real log visible in Railway,
# verifies the persisted /root/mlx volume and Linux browser dependencies,
# then hands the container over to checkCoreDownload.js.

log() {
  printf '%s\n' "$*"
}

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

on_error() {
  local exit_code=$?
  local line_number=${1:-unknown}

  log "❌ Entrypoint failed at line ${line_number} with exit code ${exit_code}"

  if [[ -f /tmp/mlx-launcher.log ]]; then
    log "----- last 200 launcher log lines -----"
    tail -n 200 /tmp/mlx-launcher.log || true
    log "---------------------------------------"
  fi

  exit "$exit_code"
}

trap 'on_error $LINENO' ERR

export HOME="${HOME:-/root}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/root/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/root/.cache}"
export TMPDIR="${TMPDIR:-/tmp}"

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$TMPDIR" /root/mlx
chmod 700 "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" 2>/dev/null || true
chmod 1777 "$TMPDIR" 2>/dev/null || true

log "🕒 Entrypoint started at $(timestamp)"
log "🏠 HOME=${HOME}"
log "💾 Railway volume mount: ${RAILWAY_VOLUME_MOUNT_PATH:-not reported}"
log "💾 Multilogin data directory: /root/mlx"
log "👤 Runtime user: $(id -u):$(id -g) ($(id -un 2>/dev/null || true))"

build_database_url_if_needed() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    log "✅ DATABASE_URL already provided"
    return 0
  fi

  local missing=0
  local name

  for name in DB_USER DB_HOST DB_NAME DB_PASSWORD; do
    if [[ -z "${!name:-}" ]]; then
      log "⚠️ Missing ${name}"
      missing=1
    fi
  done

  if [[ "$missing" -eq 1 ]]; then
    log "⚠️ DATABASE_URL was not provided and DB_* variables are incomplete."
    log "   Continuing because the core monitor does not require the database."
    return 0
  fi

  DATABASE_URL="$(
    node -e '
      const user = encodeURIComponent(process.env.DB_USER);
      const password = encodeURIComponent(process.env.DB_PASSWORD);
      const host = process.env.DB_HOST;
      const port = process.env.DB_PORT || "5432";
      const database = encodeURIComponent(process.env.DB_NAME);
      process.stdout.write(
        `postgresql://${user}:${password}@${host}:${port}/${database}?sslmode=require`
      );
    '
  )"

  export DATABASE_URL
  log "✅ Built DATABASE_URL from DB_* variables"
}

build_database_url_if_needed

print_runtime_diagnostics() {
  log "===== RUNTIME DIAGNOSTICS ====="

  log "--- memory ---"
  free -h 2>/dev/null || true

  log "--- disk ---"
  df -h /root/mlx /tmp 2>/dev/null || true

  log "--- shared memory ---"
  df -h /dev/shm 2>/dev/null || true

  log "--- Multilogin storage ---"
  du -sh /root/mlx 2>/dev/null || true
  find /root/mlx -type f 2>/dev/null | wc -l | awk '{print "files:", $1}' || true

  log "--- existing local cores ---"
  find /root/mlx/deps     -maxdepth 2     -type f     \( -name chrome -o -name VERSION -o -name adapter.bin \)     -ls 2>/dev/null || true

  local chrome_path
  chrome_path="$(
    find /root/mlx/deps       -maxdepth 3       -type f       -name chrome       -perm -111       2>/dev/null |
      head -n 1 || true
  )"

  if [[ -n "$chrome_path" ]]; then
    log "--- Mimic Chrome executable ---"
    ls -lh "$chrome_path" || true
    file "$chrome_path" || true

    if command -v ldd >/dev/null 2>&1; then
      log "--- missing shared libraries ---"

      local missing_libraries
      missing_libraries="$(ldd "$chrome_path" 2>/dev/null | grep "not found" || true)"

      if [[ -n "$missing_libraries" ]]; then
        printf '%s\n' "$missing_libraries"
      else
        log "(none reported by ldd)"
      fi
    fi
  else
    log "ℹ️ No Mimic Chrome executable found yet."
  fi

  log "==============================="
}

print_runtime_diagnostics

MLX_URL="${MULTILOGIN_LAUNCHER_URL:-https://launcher.mlx.yt:45001}"
MLX_LOG="/tmp/mlx-launcher.log"
MLX_PID_FILE="/tmp/mlx-launcher.pid"

launcher_ready() {
  curl -ksSf     --connect-timeout 3     --max-time 10     "${MLX_URL}/api/v1/version"     >/dev/null 2>&1
}

kill_processes_on_launcher_ports() {
  log "🔫 Clearing Multilogin launcher ports 45000-45003..."

  local port
  for port in 45000 45001 45002 45003; do
    fuser -k "${port}/tcp" 2>/dev/null || true
  done

  sleep 2
}

find_launcher() {
  local candidates=(
    "/usr/local/bin/launcher"
    "/usr/local/bin/mlx-launcher"
    "/usr/bin/mlx-launcher"
    "/opt/mlx/mlx-launcher"
    "/opt/multilogin/launcher"
    "/app/mlx-launcher"
    "/home/launcher/launcher"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  find /     -maxdepth 5     -type f     \( -iname '*mlx*launcher*' -o -iname 'launcher' \)     -perm -111     2>/dev/null |
    head -n 1 || true
}

start_launcher_if_needed() {
  if launcher_ready; then
    log "✅ Multilogin launcher is already running"
    return 0
  fi

  kill_processes_on_launcher_ports

  log "🔎 Locating Multilogin launcher inside the image..."

  local launcher_path
  launcher_path="$(find_launcher)"

  if [[ -z "$launcher_path" ]]; then
    log "❌ Could not locate the Multilogin launcher executable."
    return 1
  fi

  log "🚀 Starting Multilogin launcher: ${launcher_path}"

  : >"$MLX_LOG"

  nohup "$launcher_path" >>"$MLX_LOG" 2>&1 &

  local launcher_pid=$!
  printf '%s\n' "$launcher_pid" >"$MLX_PID_FILE"

  log "✅ Launcher process created with PID ${launcher_pid}"

  tail -n 0 -F "$MLX_LOG" | sed -u 's/^/[MLX] /' &

  local tail_pid=$!
  log "📜 Launcher log stream started with PID ${tail_pid}"
}

wait_for_launcher() {
  local attempts="${MULTILOGIN_LAUNCHER_WAIT_ATTEMPTS:-60}"
  local delay="${MULTILOGIN_LAUNCHER_WAIT_SECONDS:-2}"

  log "⏳ Waiting for Multilogin launcher at ${MLX_URL}..."

  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if launcher_ready; then
      log "✅ Multilogin launcher is ready"
      return 0
    fi

    log "   attempt ${attempt}/${attempts}"

    if [[ $((attempt % 5)) -eq 0 ]] && [[ -f "$MLX_LOG" ]]; then
      log "   --- launcher log snapshot ---"
      tail -n 30 "$MLX_LOG" || true
      log "   -----------------------------"
    fi

    sleep "$delay"
  done

  log "❌ Multilogin launcher did not become ready"

  if [[ -f "$MLX_LOG" ]]; then
    log "----- launcher log -----"
    tail -n 200 "$MLX_LOG" || true
    log "------------------------"
  fi

  return 1
}

start_launcher_if_needed
wait_for_launcher

log "--- launcher log at handoff ---"
tail -n 100 "$MLX_LOG" 2>/dev/null || true
log "--------------------------------"

print_runtime_diagnostics

CHECKER_FILE="/app/checkCoreDownload.js"

if [[ ! -f "$CHECKER_FILE" ]]; then
  log "❌ Missing ${CHECKER_FILE}"
  exit 1
fi

log "▶️ Starting Multilogin core/browser monitor..."
log "▶️ Executing: node ${CHECKER_FILE}"

exec node "$CHECKER_FILE"
