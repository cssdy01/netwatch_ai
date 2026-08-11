#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="${NETWATCH_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
RUN_USER="${SUDO_USER:-${USER:-$(id -un)}}"

BACKEND_DIR="$APP_ROOT/backend"
BACKEND_ENV="$BACKEND_DIR/.env"
BACKEND_COMPOSE="$BACKEND_DIR/compose.yaml"
BACKEND_NETWORK="${BACKEND_NETWORK:-backend_netwatch-internal}"

DOCKER_GW=""
DOCKER_SUBNET=""
DOCKER_USE_SUDO=0
DOCKER_GROUP_CHANGED=0

# -----------------------------------------------------------------------------
# Colors and logging
# -----------------------------------------------------------------------------

C_RESET='\033[0m'
C_GREEN='\033[32m'
C_YELLOW='\033[33m'
C_RED='\033[31m'
C_BLUE='\033[36m'

info() {
    printf "${C_BLUE}[INFO]${C_RESET} %s\n" "$*"
}

ok() {
    printf "${C_GREEN}[OK]${C_RESET} %s\n" "$*"
}

warn() {
    printf "${C_YELLOW}[WARN]${C_RESET} %s\n" "$*" >&2
}

die() {
    printf "${C_RED}[FAIL]${C_RESET} %s\n" "$*" >&2
    exit 1
}

header() {
    printf "\n${C_BLUE}============================================================${C_RESET}\n"
    printf "  %s\n" "$*"
    printf "${C_BLUE}============================================================${C_RESET}\n"
}

# -----------------------------------------------------------------------------
# Root and command helpers
# -----------------------------------------------------------------------------

if [ "$(id -u)" -eq 0 ]; then
    SUDO=()
else
    SUDO=(sudo)
fi

run_root() {
    "${SUDO[@]}" "$@"
}

docker_cmd() {
    if [ "$DOCKER_USE_SUDO" -eq 1 ]; then
        run_root docker "$@"
    else
        docker "$@"
    fi
}

compose_cmd() {
    local directory="$1"
    shift

    (
        cd "$directory"
        docker_cmd compose "$@"
    )
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# -----------------------------------------------------------------------------
# Operating-system checks
# -----------------------------------------------------------------------------

check_os() {
    header "Checking operating system"

    if [ ! -f /etc/os-release ]; then
        warn "/etc/os-release was not found; continuing."
        return 0
    fi

    # shellcheck disable=SC1091
    . /etc/os-release

    info "Detected: ${PRETTY_NAME:-unknown}"

    case "${ID:-}" in
        fedora|centos|rhel|rocky|almalinux|ol|oracle)
            ok "Supported Red Hat family OS detected."
            ;;
        *)
            warn "This installer was designed for Fedora/RHEL-family systems."
            ;;
    esac
}

# -----------------------------------------------------------------------------
# Optional Podman conflict removal
# -----------------------------------------------------------------------------

remove_podman() {
    header "Checking for Podman conflicts"

    if command_exists podman || rpm -q podman >/dev/null 2>&1; then
        warn "Podman was detected."
        info "Removing Podman, Buildah, Skopeo, and podman-docker packages..."

        run_root dnf remove -y \
            podman \
            buildah \
            skopeo \
            podman-docker \
            >/dev/null 2>&1 || true

        ok "Podman conflict packages were removed or were not installed."
    else
        ok "No Podman installation detected."
    fi
}

# -----------------------------------------------------------------------------
# Docker installation
# -----------------------------------------------------------------------------

install_docker() {
    header "Installing Docker Engine"

    if command_exists docker && docker --version >/dev/null 2>&1; then
        ok "Docker is already installed: $(docker --version)"
    else
        info "Installing repository prerequisites..."

        run_root dnf install -y \
            dnf-plugins-core \
            ca-certificates \
            curl \
            gnupg2

        if [ ! -f /etc/yum.repos.d/docker-ce.repo ]; then
            info "Adding the Docker CE repository..."

            run_root dnf config-manager \
                --add-repo \
                https://download.docker.com/linux/centos/docker-ce.repo
        else
            ok "Docker CE repository is already configured."
        fi

        info "Installing Docker Engine and Compose..."

        run_root dnf install -y \
            docker-ce \
            docker-ce-cli \
            containerd.io \
            docker-buildx-plugin \
            docker-compose-plugin \
            --allowerasing

        ok "Docker packages installed."
    fi

    run_root systemctl enable --now docker

    if run_root systemctl is-active --quiet docker; then
        ok "Docker service is running."
    else
        die "Docker service failed to start."
    fi

    docker --version 2>/dev/null || run_root docker --version
    docker compose version 2>/dev/null || run_root docker compose version
}

# -----------------------------------------------------------------------------
# Docker group configuration
# -----------------------------------------------------------------------------

configure_docker_group() {
    header "Configuring Docker group"

    if ! getent group docker >/dev/null 2>&1; then
        run_root groupadd docker
        ok "Created the docker group."
    else
        ok "Docker group already exists."
    fi

    if id -nG "$RUN_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
        ok "$RUN_USER is already in the docker group."
    else
        run_root usermod -aG docker "$RUN_USER"
        DOCKER_GROUP_CHANGED=1
        ok "Added $RUN_USER to the docker group."
        warn "Group membership will become active after a new login or: newgrp docker"
    fi
}

setup_docker_command() {
    header "Checking Docker access"

    if docker info >/dev/null 2>&1; then
        DOCKER_USE_SUDO=0
        ok "Docker is accessible without sudo."
        return 0
    fi

    if run_root docker info >/dev/null 2>&1; then
        DOCKER_USE_SUDO=1
        warn "Docker is currently accessible only through sudo."
        warn "Run 'newgrp docker' after this setup finishes."
        return 0
    fi

    die "Docker daemon is not accessible."
}

# -----------------------------------------------------------------------------
# External Docker networks
# -----------------------------------------------------------------------------

ensure_networks() {
    header "Configuring external Docker networks"

    local network

    for network in netwatch-network netwatch-ai-network; do
        if docker_cmd network inspect "$network" >/dev/null 2>&1; then
            ok "Network exists: $network"
        else
            docker_cmd network create "$network" >/dev/null
            ok "Created network: $network"
        fi
    done
}

# -----------------------------------------------------------------------------
# Mail dependencies
# -----------------------------------------------------------------------------

install_postfix() {
    header "Installing Postfix and mail tools"

    local packages=()

    command_exists postfix || packages+=(postfix)

    if ! command_exists mail && ! command_exists mailx; then
        packages+=(mailx)
    fi

    command_exists nc || packages+=(nc)

    if [ "${#packages[@]}" -gt 0 ]; then
        info "Installing: ${packages[*]}"
        run_root dnf install -y "${packages[@]}"
        ok "Mail dependencies installed."
    else
        ok "Postfix, mailx, and nc are already installed."
    fi

    run_root systemctl enable --now postfix

    if run_root systemctl is-active --quiet postfix; then
        ok "Host Postfix service is running."
    else
        die "Host Postfix failed to start."
    fi
}

# -----------------------------------------------------------------------------
# Backend Compose network detection
# -----------------------------------------------------------------------------

locate_backend_network() {
    docker_cmd network inspect "$BACKEND_NETWORK" >/dev/null 2>&1
}

create_backend_network_if_missing() {
    if locate_backend_network; then
        return 0
    fi

    warn "Backend network does not exist yet: $BACKEND_NETWORK"

    if [ ! -f "$BACKEND_COMPOSE" ]; then
        die "Backend Compose file is missing: $BACKEND_COMPOSE"
    fi

    if [ ! -f "$BACKEND_ENV" ]; then
        die "Backend environment file is missing: $BACKEND_ENV"
    fi

    info "Creating the backend Compose network and PostgreSQL service..."

    compose_cmd "$BACKEND_DIR" up -d postgres

    local attempt

    for attempt in $(seq 1 30); do
        if locate_backend_network; then
            ok "Backend network was created."
            return 0
        fi

        sleep 1
    done

    die "Could not create or locate Docker network: $BACKEND_NETWORK"
}

detect_docker_network() {
    header "Detecting the Netwatch backend Docker network"

    create_backend_network_if_missing

    DOCKER_GW="$(
        docker_cmd network inspect \
            "$BACKEND_NETWORK" \
            --format '{{(index .IPAM.Config 0).Gateway}}'
    )"

    DOCKER_SUBNET="$(
        docker_cmd network inspect \
            "$BACKEND_NETWORK" \
            --format '{{(index .IPAM.Config 0).Subnet}}'
    )"

    [ -n "$DOCKER_GW" ] || die "Could not determine the gateway for $BACKEND_NETWORK."
    [ -n "$DOCKER_SUBNET" ] || die "Could not determine the subnet for $BACKEND_NETWORK."

    info "Backend network: $BACKEND_NETWORK"
    info "Backend gateway: $DOCKER_GW"
    info "Backend subnet:  $DOCKER_SUBNET"

    ok "Netwatch backend network information detected."
}

# -----------------------------------------------------------------------------
# Backend relay environment
# -----------------------------------------------------------------------------

update_backend_postfix_relay() {
    header "Configuring the backend Postfix relay"

    if [ ! -f "$BACKEND_ENV" ]; then
        warn "Backend environment file not found: $BACKEND_ENV"
        warn "Set POSTFIX_RELAY=${DOCKER_GW}:25 manually."
        return 0
    fi

    if grep -q '^POSTFIX_RELAY=' "$BACKEND_ENV"; then
        sed -i \
            "s|^POSTFIX_RELAY=.*|POSTFIX_RELAY=${DOCKER_GW}:25|" \
            "$BACKEND_ENV"
    else
        printf '\nPOSTFIX_RELAY=%s:25\n' "$DOCKER_GW" >> "$BACKEND_ENV"
    fi

    chmod 600 "$BACKEND_ENV" 2>/dev/null || true

    ok "Backend POSTFIX_RELAY set to ${DOCKER_GW}:25."
}

# -----------------------------------------------------------------------------
# Host Postfix configuration
# -----------------------------------------------------------------------------

configure_postfix_relay() {
    header "Configuring host Postfix for the Netwatch Docker subnet"

    local postfix_backup
    local inet_interfaces
    local inet_protocols
    local mynetworks

    postfix_backup="/etc/postfix/main.cf.netwatch.$(date +%Y%m%d-%H%M%S).bak"

    run_root cp -p /etc/postfix/main.cf "$postfix_backup"
    ok "Postfix configuration backup: $postfix_backup"

    run_root postconf -e 'inet_interfaces = all'
    run_root postconf -e 'inet_protocols = ipv4'
    run_root postconf -e "mynetworks = 127.0.0.0/8, ${DOCKER_SUBNET}"

    if run_root postfix check; then
        ok "Postfix configuration validation passed."
    else
        die "Postfix configuration validation failed."
    fi

    run_root systemctl restart postfix

    if ! run_root systemctl is-active --quiet postfix; then
        die "Postfix failed after the configuration change."
    fi

    inet_interfaces="$(run_root postconf -h inet_interfaces)"
    inet_protocols="$(run_root postconf -h inet_protocols)"
    mynetworks="$(run_root postconf -h mynetworks)"

    info "Postfix inet_interfaces: $inet_interfaces"
    info "Postfix inet_protocols:  $inet_protocols"
    info "Postfix mynetworks:      $mynetworks"

    [ "$inet_interfaces" = "all" ] || \
        die "Postfix inet_interfaces is '$inet_interfaces'; expected 'all'."

    [ "$inet_protocols" = "ipv4" ] || \
        die "Postfix inet_protocols is '$inet_protocols'; expected 'ipv4'."

    if ! printf '%s\n' "$mynetworks" | grep -Fq "$DOCKER_SUBNET"; then
        die "Postfix mynetworks does not include $DOCKER_SUBNET."
    fi

    if run_root ss -lntp | grep -Eq '0\.0\.0\.0:25|[[:space:]]\*:25'; then
        ok "Host Postfix is listening on a Docker-reachable IPv4 port 25."
    else
        die "Host Postfix is not listening on a Docker-reachable IPv4 port 25."
    fi

    update_backend_postfix_relay
}

# -----------------------------------------------------------------------------
# Firewall configuration
# -----------------------------------------------------------------------------

configure_firewall() {
    header "Configuring the firewall"

    if ! command_exists firewall-cmd; then
        warn "firewalld is not installed; skipping firewall configuration."
        return 0
    fi

    if ! run_root firewall-cmd --state >/dev/null 2>&1; then
        warn "firewalld is not running; skipping firewall configuration."
        return 0
    fi

    local smtp_rule

    smtp_rule="rule family=\"ipv4\" source address=\"${DOCKER_SUBNET}\" port port=\"25\" protocol=\"tcp\" accept"

    if run_root firewall-cmd \
        --permanent \
        --query-rich-rule="$smtp_rule" \
        >/dev/null 2>&1; then

        ok "Firewall SMTP rule already exists for $DOCKER_SUBNET."
    else
        run_root firewall-cmd \
            --permanent \
            --add-rich-rule="$smtp_rule"

        run_root firewall-cmd --reload

        ok "Firewall now permits SMTP from $DOCKER_SUBNET."
    fi
}

# -----------------------------------------------------------------------------
# Docker-to-host Postfix connectivity test
# -----------------------------------------------------------------------------

smtp_test_from_running_backend() {
    local backend_id="$1"

    docker_cmd exec "$backend_id" sh -c \
        "printf 'QUIT\r\n' | timeout 5 nc '${DOCKER_GW}' 25" \
        2>/dev/null || true
}

smtp_test_from_temporary_container() {
    docker_cmd run \
        --rm \
        --network "$BACKEND_NETWORK" \
        alpine:3.20 \
        sh -c \
        "apk add --no-cache netcat-openbsd >/dev/null 2>&1; printf 'QUIT\r\n' | nc -w 5 '${DOCKER_GW}' 25" \
        2>/dev/null || true
}

test_postfix() {
    header "Testing Docker-to-Postfix connectivity"

    local backend_id=""
    local smtp_output=""

    if [ -f "$BACKEND_COMPOSE" ]; then
        backend_id="$(compose_cmd "$BACKEND_DIR" ps -q backend 2>/dev/null | head -n 1 || true)"
    fi

    if [ -n "$backend_id" ]; then
        info "Testing from the running backend container..."
        smtp_output="$(smtp_test_from_running_backend "$backend_id")"
    else
        info "Backend is not running; testing from a temporary Alpine container..."
        smtp_output="$(smtp_test_from_temporary_container)"
    fi

    if printf '%s\n' "$smtp_output" | grep -q '^220 '; then
        ok "Docker can reach host Postfix at ${DOCKER_GW}:25."
    else
        warn "Docker could not read an SMTP banner from ${DOCKER_GW}:25."
        warn "Review Postfix, firewalld, and SELinux configuration."
        printf '\nSMTP test output:\n%s\n\n' "${smtp_output:-No output}"
    fi
}

# -----------------------------------------------------------------------------
# Netwatch directories and script permissions
# -----------------------------------------------------------------------------

prepare_directories() {
    header "Preparing Netwatch directories"

    mkdir -p \
        "$APP_ROOT/backups/database" \
        "$APP_ROOT/exports/images" \
        "$APP_ROOT/logs"

    chmod 700 \
        "$APP_ROOT/backups" \
        "$APP_ROOT/exports" \
        "$APP_ROOT/logs" \
        2>/dev/null || true

    ok "Netwatch directories prepared."
}

prepare_scripts() {
    header "Preparing deployment scripts"

    local file

    for file in \
        "$APP_ROOT/independent-ai-gateway/deploy.sh" \
        "$APP_ROOT/backend/deploy.sh" \
        "$APP_ROOT/frontend/deploy.sh"; do

        if [ -f "$file" ]; then
            chmod 700 "$file"
            ok "Executable: $file"
        fi
    done

    find "$SCRIPT_DIR" \
        -maxdepth 1 \
        -type f \
        -name '*.sh' \
        -exec chmod 700 {} \;

    ok "Shell scripts prepared."
}

# -----------------------------------------------------------------------------
# Final verification
# -----------------------------------------------------------------------------

verify_installation() {
    header "Final verification"

    local postfix_interfaces
    local postfix_networks
    local configured_relay=""

    command_exists docker || die "Docker command is unavailable."

    if docker_cmd compose version >/dev/null 2>&1; then
        ok "Docker Compose: $(docker_cmd compose version)"
    else
        die "Docker Compose plugin is unavailable."
    fi

    if run_root systemctl is-active --quiet docker; then
        ok "Docker service: running"
    else
        die "Docker service: not running"
    fi

    if run_root systemctl is-active --quiet postfix; then
        ok "Postfix service: running"
    else
        die "Postfix service: not running"
    fi

    for network in netwatch-network netwatch-ai-network "$BACKEND_NETWORK"; do
        if docker_cmd network inspect "$network" >/dev/null 2>&1; then
            ok "Docker network: $network"
        else
            warn "Docker network missing: $network"
        fi
    done

    postfix_interfaces="$(run_root postconf -h inet_interfaces 2>/dev/null || true)"
    postfix_networks="$(run_root postconf -h mynetworks 2>/dev/null || true)"

    if [ "$postfix_interfaces" = "all" ]; then
        ok "Postfix listener: all interfaces"
    else
        warn "Postfix listener is '$postfix_interfaces'; expected 'all'."
    fi

    if printf '%s\n' "$postfix_networks" | grep -Fq "$DOCKER_SUBNET"; then
        ok "Postfix trusted subnet: $DOCKER_SUBNET"
    else
        warn "Postfix does not trust $DOCKER_SUBNET."
    fi

    if [ -f "$BACKEND_ENV" ]; then
        configured_relay="$(sed -n 's/^POSTFIX_RELAY=//p' "$BACKEND_ENV" | tail -n 1)"
    fi

    if [ "$configured_relay" = "${DOCKER_GW}:25" ]; then
        ok "Backend relay: ${DOCKER_GW}:25"
    else
        warn "Backend relay is '$configured_relay'; expected '${DOCKER_GW}:25'."
    fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
    printf '\n'
    printf 'Netwatch Docker Setup\n'
    printf '=====================\n'
    printf 'Application root: %s\n' "$APP_ROOT"
    printf 'Run user:         %s\n' "$RUN_USER"
    printf 'Backend network:  %s\n' "$BACKEND_NETWORK"
    printf '\n'

    check_os
    remove_podman
    install_docker
    configure_docker_group
    setup_docker_command

    ensure_networks

    install_postfix
    detect_docker_network
    configure_postfix_relay
    configure_firewall
    test_postfix

    prepare_directories
    prepare_scripts
    verify_installation

    printf '\n'
    printf "${C_GREEN}============================================================${C_RESET}\n"
    printf "${C_GREEN} Netwatch setup completed successfully.${C_RESET}\n"
    printf "${C_GREEN}============================================================${C_RESET}\n"
    printf '\n'

    if [ "$DOCKER_GROUP_CHANGED" -eq 1 ] || \
       ! id -nG "$RUN_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then

        warn "Docker group membership needs a new login or shell."
        printf 'Run this command after the setup script exits:\n\n'
        printf '    newgrp docker\n\n'
    else
        ok "Docker group membership is active."
    fi

    printf 'Detected mail relay configuration:\n\n'
    printf '    Backend network: %s\n' "$BACKEND_NETWORK"
    printf '    Docker subnet:   %s\n' "$DOCKER_SUBNET"
    printf '    Docker gateway:  %s\n' "$DOCKER_GW"
    printf '    POSTFIX_RELAY:   %s:25\n\n' "$DOCKER_GW"

    printf 'Next, run the Netwatch precheck:\n\n'
    printf '    %s/2_precheck.sh\n\n' "$SCRIPT_DIR"
}

main "$@"
