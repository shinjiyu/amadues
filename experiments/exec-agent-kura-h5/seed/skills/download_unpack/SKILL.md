# Download and unpack

1. GET Content-Length (or note expected size) for the origin zip URL from Kura fetch.
2. Start download in the background into `assets/<name>.zip` (curl -L --retry, or curl -C - to resume).
3. Poll `ls -l` until size is stable ≥2 checks apart (or size >= Content-Length).
4. Only then: `unzip -t` once; if OK, `unzip -oq` once into `assets/hexkit` (or similar).
5. If unzip fails with end-of-central-directory: delete partial zip and resume download — do not spam unzip.
6. While waiting on step 3, you may prepare `models/`, `reports/`, and page skeleton in parallel (see skill:parallel_while_download).
