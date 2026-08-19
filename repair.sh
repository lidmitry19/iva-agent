#!/usr/bin/env bash
set -Eeuo pipefail

# One-time bridge from legacy, dirty Iva checkouts to the current updater.
# User-facing entrypoint:
#   curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/repair.sh | bash

REPO_URL="${IVA_REPAIR_REPO_URL:-https://github.com/smixs/iva-agent.git}"
BRANCH="${IVA_REPAIR_BRANCH:-main}"
INSTALL_DIR="${IVA_INSTALL_DIR:-${HOME}/iva}"
SKIP_RESTART="${IVA_REPAIR_SKIP_RESTART:-0}"

say() { printf '%s\n' "$*"; }
die() { printf 'Iva repair failed: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required"
command -v npm >/dev/null 2>&1 || die "npm is required"
command -v node >/dev/null 2>&1 || die "Node.js is required"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 24 ] || die "Node 24 or newer is required"
if [ ! -d "$INSTALL_DIR/.git" ] && [ -d "$INSTALL_DIR/versions" ]; then
  die "$INSTALL_DIR already runs versioned installs: use 'iva update', or 'iva rollback' to return to the previous version"
fi
[ -d "$INSTALL_DIR/.git" ] || die "Iva was not found at $INSTALL_DIR"

INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
HOME_DIR="$(cd "$HOME" && pwd -P)"
PARENT_DIR="$(dirname "$INSTALL_DIR")"
INSTALL_NAME="$(basename "$INSTALL_DIR")"
[ "$INSTALL_DIR" != "/" ] || die "unsafe installation path"
[ "$INSTALL_DIR" != "$HOME_DIR" ] || die "unsafe installation path"
[ -f "$INSTALL_DIR/package.json" ] || die "package.json is missing"
node -e 'const p=require(process.argv[1]); if(p.name!=="iva") process.exit(1)' \
  "$INSTALL_DIR/package.json" || die "this is not an Iva installation"

top="$(git -C "$INSTALL_DIR" rev-parse --show-toplevel)"
[ "$(cd "$top" && pwd -P)" = "$INSTALL_DIR" ] || die "invalid Iva checkout"

# The repository is smixs/iva-agent. Installs made before 2026-08-19 still keep
# origin = smixs/iva, which GitHub redirects, so both names stay official.
is_official_remote() {
  case "$1" in
    https://github.com/smixs/iva-agent|https://github.com/smixs/iva-agent.git|git@github.com:smixs/iva-agent|git@github.com:smixs/iva-agent.git|ssh://git@github.com/smixs/iva-agent|ssh://git@github.com/smixs/iva-agent.git) return 0 ;;
    https://github.com/smixs/iva|https://github.com/smixs/iva.git|git@github.com:smixs/iva|git@github.com:smixs/iva.git|ssh://git@github.com/smixs/iva|ssh://git@github.com/smixs/iva.git) return 0 ;;
    *) return 1 ;;
  esac
}

origin="$(git -C "$INSTALL_DIR" remote get-url origin)"
if is_official_remote "$origin"; then
  is_official_remote "$REPO_URL" || die "repository URL is not github.com/smixs/iva-agent"
elif [ "${REPO_URL#/}" != "$REPO_URL" ] && [ "$origin" = "$REPO_URL" ] && [ -d "$REPO_URL" ]; then
  [ "$(git --git-dir="$REPO_URL" rev-parse --is-bare-repository 2>/dev/null)" = "true" ] \
    || die "invalid local test repository"
else
  die "origin is not github.com/smixs/iva-agent"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
candidate="$PARENT_DIR/.${INSTALL_NAME}.repair-candidate-${stamp}-$$"
state_dir="$PARENT_DIR/.${INSTALL_NAME}.repair-state-${stamp}-$$"
backup="$PARENT_DIR/${INSTALL_NAME}-backup-${stamp}"
failed_candidate="$PARENT_DIR/.${INSTALL_NAME}.failed-repair-${stamp}"
activated=0

for path in "$candidate" "$state_dir" "$backup" "$failed_candidate"; do
  [ ! -e "$path" ] && [ ! -L "$path" ] || die "repair path already exists: $path"
done

safe_remove() {
  case "$1" in
    "$PARENT_DIR"/."$INSTALL_NAME".repair-candidate-*|"$PARENT_DIR"/."$INSTALL_NAME".repair-state-*)
      rm -rf -- "$1"
      ;;
    *) die "refusing to remove unexpected path: $1" ;;
  esac
}

rollback() {
  code="${1:-$?}"
  trap - ERR INT TERM EXIT
  if [ "$activated" = "1" ] && [ -d "$backup" ]; then
    if [ -e "$INSTALL_DIR" ]; then
      [ ! -e "$failed_candidate" ] || failed_candidate="${failed_candidate}-$$"
      mv -- "$INSTALL_DIR" "$failed_candidate" || true
    fi
    mv -- "$backup" "$INSTALL_DIR" || true
    if [ "$SKIP_RESTART" != "1" ]; then
      node "$INSTALL_DIR/bin/iva.mjs" restart >/dev/null 2>&1 || true
    fi
  fi
  [ ! -e "$candidate" ] || (safe_remove "$candidate") || true
  [ ! -e "$state_dir" ] || (safe_remove "$state_dir") || true
  exit "$code"
}
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

# Ignored paths the installation makes for itself out of the repo: a copy of them is a
# copy of the code, never of the user, and npm ci / `iva userbot setup` / the next build
# write them again. Everything else git ignores belongs to whoever runs this.
rebuildable() {
  case "${1%/}" in
    node_modules|*/node_modules) return 0 ;;
    .venv|*/.venv) return 0 ;;                          # rebuilt from requirements.lock
    __pycache__|*/__pycache__|*.pyc) return 0 ;;
    # Anchored exactly as .gitignore anchors each name: these at any depth…
    .output|*/.output|.eve|*/.eve|dist|*/dist) return 0 ;;
    .next|*/.next|.nitro|*/.nitro|.vercel|*/.vercel|.netlify|*/.netlify) return 0 ;;
    # …and these only at the top, where /.iva-update/ and /.iva-build/ live.
    .iva-update|.iva-build) return 0 ;;                 # updater scratch
    *.tsbuildinfo|.DS_Store|*/.DS_Store) return 0 ;;
  esac
  return 1
}

# Persistent state copied byte-for-byte further down; listing it twice would only
# report every one of these paths as a conflict with itself. `.env.*` means what that
# loop actually takes — regular files at the top level — so a symlinked or directory
# form of one is left to the complete backup, exactly as it was before this list.
copied_byte_for_byte() {
  case "${1%/}" in
    .env|.env.*|data|vault|attachments|.workflow-data|.eve/.workflow-data) return 0 ;;
  esac
  return 1
}

mkdir -m 700 -- "$state_dir"
original_head="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
git -C "$INSTALL_DIR" diff --binary HEAD >"$state_dir/changes.patch"
git -C "$INSTALL_DIR" ls-files --others --exclude-standard -z >"$state_dir/untracked.zlist"
# What git ignores inside the checkout is the user's as much as an untracked file is:
# a skill's credentials, the Telethon session, local notes. Listing only the untracked
# ones left all of that behind in a backup this script then tells the user to remove.
# --directory collapses a wholly ignored directory into a single entry, so this never
# walks node_modules to name it. A directory that is unreadable AND not matched by an
# ignore rule is not listed at all: git cannot see inside to decide, so it stays out of
# ignored.raw — its contents live in the complete backup and are never named in
# conflicts.txt. (A directory ignored BY NAME is still listed even at mode 000: git
# needs no read to match the rule. This is an inherited limit of asking git, and the
# backup is whole either way.)
#
# Listed into a file, not through a process substitution: there git's exit status is
# nobody's, so a failed listing would read as "nothing is ignored here" and quietly
# leave every one of these files behind. As a plain redirect it is a command like any
# other, and errexit stops the repair while it has still touched nothing. git's own
# stderr ("warning: could not open directory …" for an unreadable path) goes to a file,
# not the user's screen mid-repair.
git -C "$INSTALL_DIR" ls-files --others --ignored --exclude-standard --directory -z \
  >"$state_dir/ignored.raw" 2>"$state_dir/ignored.err"
: >"$state_dir/ignored.zlist"
while IFS= read -r -d '' ignored; do
  if rebuildable "$ignored"; then continue; fi
  if copied_byte_for_byte "$ignored"; then continue; fi
  printf '%s\0' "${ignored%/}" >>"$state_dir/ignored.zlist"
done <"$state_dir/ignored.raw"
: >"$state_dir/persistent-conflicts.txt"

say "Saving the current Iva..."
git clone --quiet --branch "$BRANCH" --single-branch "$REPO_URL" "$candidate"
target_head="$(git -C "$candidate" rev-parse HEAD)"

# Persistent state is copied byte-for-byte. The full old installation is also kept as backup.
for name in .env vault attachments; do
  if [ -e "$INSTALL_DIR/$name" ] || [ -L "$INSTALL_DIR/$name" ]; then
    rm -rf -- "${candidate:?}/$name"
    cp -a -- "$INSTALL_DIR/$name" "$candidate/$name"
  fi
done
if [ -e "$INSTALL_DIR/data" ] || [ -L "$INSTALL_DIR/data" ]; then
  rm -rf -- "${candidate:?}/data"
  if [ -d "$INSTALL_DIR/data" ]; then
    mkdir -p -- "$candidate/data"
    cp -a -- "$INSTALL_DIR/data/." "$candidate/data/"
  else
    cp -aL -- "$INSTALL_DIR/data" "$candidate/data"
  fi
fi
for name in .workflow-data .eve/.workflow-data; do
  if [ -e "$INSTALL_DIR/$name" ] || [ -L "$INSTALL_DIR/$name" ]; then
    rm -rf -- "${candidate:?}/$name"
    mkdir -p -- "$candidate/$name"
    cp -a -- "$INSTALL_DIR/$name/." "$candidate/$name/"
  fi
done
while IFS= read -r -d '' env_file; do
  name="$(basename "$env_file")"
  [ "$name" = ".env.example" ] && continue
  if git -C "$candidate" ls-files --error-unmatch -- "$name" >/dev/null 2>&1; then
    printf '%s\n' "$name (local environment file conflicts with a core file)" >>"$state_dir/persistent-conflicts.txt"
    continue
  fi
  cp -a -- "$env_file" "$candidate/$name"
done < <(find "$INSTALL_DIR" -maxdepth 1 -type f -name '.env.*' -print0)

mkdir -p -- "$candidate/data/update-recovery/$stamp"
recovery="$candidate/data/update-recovery/$stamp"
# Both paths are absolute, so no end-of-options marker is needed to keep them apart from flags.
chmod 700 "$candidate/data/update-recovery" "$recovery"
final_recovery="$INSTALL_DIR/data/update-recovery/$stamp"
cp -- "$state_dir/changes.patch" "$recovery/changes.patch"
cp -- "$state_dir/untracked.zlist" "$recovery/untracked.zlist"
cp -- "$state_dir/ignored.zlist" "$recovery/ignored.zlist"
: >"$recovery/conflicts.txt"
: >"$recovery/restored-untracked.zlist"
: >"$recovery/restored-ignored.zlist"
cat "$state_dir/persistent-conflicts.txt" >>"$recovery/conflicts.txt"

# Apply every tracked local edit. Conflicting files stay clean in the new core and remain
# available in the complete backup plus changes.patch.
if [ -s "$state_dir/changes.patch" ]; then
  if git -C "$candidate" apply --3way --index --whitespace=nowarn "$state_dir/changes.patch"; then
    apply_code=0
  else
    apply_code=$?
  fi
  if [ "$apply_code" -ne 0 ]; then
    # bash 3.2 (macOS) has no mapfile; NUL-delimited read also survives odd path names.
    conflicts=()
    while IFS= read -r -d '' conflict; do
      conflicts+=("$conflict")
    done < <(git -C "$candidate" diff --name-only --diff-filter=U -z)
    if [ "${#conflicts[@]}" -gt 0 ]; then
      printf '%s\n' "${conflicts[@]}" >>"$recovery/conflicts.txt"
      git -C "$candidate" checkout HEAD -- "${conflicts[@]}"
    else
      git -C "$candidate" reset --hard HEAD >/dev/null
      printf '%s\n' "changes.patch (could not be applied safely)" >>"$recovery/conflicts.txt"
    fi
  fi
fi

# Restore every user file whose path is still free. A path now owned by the fresh
# checkout is recorded as a conflict and preserved in the complete backup.
restore_paths() {
  local list="$1" record="$2" relative source_path target_path same
  while IFS= read -r -d '' relative; do
    case "$relative" in
      # `..` and `*/..` on their own too: a name that ends there escapes just as well
      # as one that continues through, and nothing downstream would notice.
      ""|.|..|*/..|/*|../*|*/../*)
        printf '%s\n' "$relative (unsafe path)" >>"$recovery/conflicts.txt"
        continue
        ;;
    esac
    source_path="$INSTALL_DIR/$relative"
    target_path="$candidate/$relative"
    [ -e "$source_path" ] || [ -L "$source_path" ] || continue
    if [ -e "$target_path" ] || [ -L "$target_path" ]; then
      same=0
      if [ -f "$source_path" ] && [ -f "$target_path" ] && cmp -s -- "$source_path" "$target_path"; then same=1; fi
      if [ -L "$source_path" ] && [ -L "$target_path" ] && [ "$(readlink "$source_path")" = "$(readlink "$target_path")" ]; then same=1; fi
      [ "$same" = "1" ] || printf '%s\n' "$relative" >>"$recovery/conflicts.txt"
      continue
    fi
    # A file this script cannot read is not a reason to abort a repair. Dirty legacy
    # checkouts - the ones this exists for - collect files written under sudo or left
    # at mode 000, and dying here would leave the user with a raw cp error, no advice,
    # and an installation still broken. The complete backup holds every byte either
    # way, so the path is named for review and the rest of the repair goes on.
    if mkdir -p -- "$(dirname "$target_path")" && cp -a -- "$source_path" "$target_path"; then
      printf '%s\0' "$relative" >>"$record"
    else
      rm -rf -- "$target_path"
      printf '%s\n' "$relative (could not be copied, likely permissions - take it from the complete backup by hand)" >>"$recovery/conflicts.txt"
    fi
  done <"$list"
}

restore_paths "$state_dir/untracked.zlist" "$recovery/restored-untracked.zlist"
# Ignored files are data, not customization: the fallback below removes what it restored
# from the untracked list, and a credential or a session is never the reason a build
# failed. They keep their own record so that fallback leaves them alone.
restore_paths "$state_dir/ignored.zlist" "$recovery/restored-ignored.zlist"

cat >"$recovery/report.txt" <<EOF
Iva repair: $stamp
Previous HEAD: $original_head
New HEAD: $target_head
Complete backup: $backup
Conflicting paths: $final_recovery/conflicts.txt
EOF

# Keep the running old process on its renamed directory while the replacement is built at
# the original path expected by systemd and the global iva command.
activated=1
mv -- "$INSTALL_DIR" "$backup"
chmod 700 "$backup"
mv -- "$candidate" "$INSTALL_DIR"
recovery="$final_recovery"

say "Installing the new updater..."
if (
  cd "$INSTALL_DIR"
  npm ci --no-audit --no-fund && npm run build
); then
  custom_build_ok=0
else
  custom_build_ok=$?
fi

if [ "$custom_build_ok" -ne 0 ]; then
  say "A customization did not build; starting clean Iva and keeping every change in the backup."
  git -C "$INSTALL_DIR" reset --hard HEAD >/dev/null
  while IFS= read -r -d '' restored; do
    [ -n "$restored" ] || continue
    target="$INSTALL_DIR/$restored"
    if [ -e "$target" ] || [ -L "$target" ]; then rm -rf -- "$target"; fi
  done <"$recovery/restored-untracked.zlist"
  (
    cd "$INSTALL_DIR"
    npm ci --no-audit --no-fund && npm run build
  )
fi

if [ "$SKIP_RESTART" != "1" ]; then
  node "$INSTALL_DIR/bin/iva.mjs" _install-units
  node "$INSTALL_DIR/bin/iva.mjs" restart
fi

trap - ERR INT TERM
activated=0
safe_remove "$state_dir"

say "Iva is repaired and updated."
say "Your complete backup: $backup"
say "Remove the backup manually after checking Iva."
if [ -s "$recovery/conflicts.txt" ]; then
  say "Files needing review: $recovery/conflicts.txt"
fi
