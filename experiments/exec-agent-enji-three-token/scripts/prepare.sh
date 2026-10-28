#!/bin/zsh
set -euo pipefail
EXP_ROOT="${0:A:h:h}"
ROOT="${WORKDIR_ROOT:-$HOME/Documents/tmp/enji-three-token-$(date +%Y%m%d)}"
mkdir -p "$ROOT"
print "WORKDIR_ROOT=$ROOT"

init_three() {
  local dir="$1"
  mkdir -p "$dir/src"
  cat > "$dir/package.json" <<'EOF'
{
  "name": "three-game-sandbox",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "three": "^0.170.0"
  },
  "devDependencies": {
    "vite": "^6.0.0"
  }
}
EOF
  cat > "$dir/index.html" <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Three.js game</title>
    <style>
      html, body, #app { margin: 0; height: 100%; background: #111; overflow: hidden; }
      canvas { display: block; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
EOF
  cat > "$dir/src/main.js" <<'EOF'
import * as THREE from 'three';

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(3, 3, 6);
camera.lookAt(0, 0, 0);
scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(5, 8, 3);
scene.add(dir);

const marker = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x4488ff }),
);
scene.add(marker);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function tick() {
  marker.rotation.y += 0.01;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
EOF
  cat > "$dir/AGENTS.md" <<'EOF'
# Three.js Vite sandbox

- Entry: `src/main.js`
- Install: `npm install`
- Dev: `npm run dev` · Build: `npm run build`
- Keep dependencies minimal; prefer editing `src/`.
EOF
  (cd "$dir" && npm install --silent)
}

# Tetris / Rubik · Enji
for case in tetris-enji rubik-enji; do
  dir="$ROOT/$case"
  if [[ -d "$dir/assets" ]]; then
    print "skip enji init (exists): $dir"
  else
    rm -rf "$dir"
    if [[ "$case" == rubik-enji ]]; then
      enji init "$dir" --3d
    else
      enji init "$dir"
    fi
  fi
done

# Tetris / Rubik · Three.js
for case in tetris-three rubik-three; do
  dir="$ROOT/$case"
  if [[ -f "$dir/package.json" ]]; then
    print "skip three scaffold (exists): $dir"
  else
    rm -rf "$dir"
    init_three "$dir"
  fi
done

# Start Enji hosts (unique ports via sequential start; enji picks free)
for case in tetris-enji rubik-enji; do
  dir="$ROOT/$case"
  enji host status --project "$dir" 2>/dev/null | rg -q '"running": true' && {
    print "host already up: $case"
    continue
  }
  print "starting enji host: $case"
  enji host start --project "$dir" --timeout 90 || true
done

mkdir -p "$EXP_ROOT/results"
print "$ROOT" > "$EXP_ROOT/results/.workdir-root"
print -- "-----"
print "export WORKDIR_ROOT=$ROOT"
for case in tetris-enji tetris-three rubik-enji rubik-three; do
  print "  $case -> $ROOT/$case"
done
