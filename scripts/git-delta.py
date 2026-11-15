"""Build an immutable ZIP containing changed files and a verified base manifest. Stdlib only."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import zipfile


def safe(path):
    if not path or re.search(r'[\\:\x00-\x1f\x7f]', path) or any(p in ('', '.', '..') or p.endswith((' ', '.')) for p in path.split('/')):
        raise ValueError('Unsafe Git path')
    if any(p.lower() in ('.git', '.env', 'id_rsa', 'id_ed25519', 'node_modules') for p in path.split('/')) or path.lower().endswith(('.pem', '.key')):
        raise ValueError('Sensitive Git path')
    return path


def git(*args):
    return subprocess.check_output(['git', *args], timeout=120)


def tree(sha):
    result = {}
    for entry in git('ls-tree', '-rz', sha).split(b'\0'):
        if not entry:
            continue
        meta, name = entry.split(b'\t', 1)
        mode, kind, blob = meta.decode('ascii').split(' ')
        path = safe(name.decode('utf-8'))
        if mode not in ('100644', '100755') or kind != 'blob':
            raise ValueError('Only regular files can be updated')
        result[path] = {'mode': int(mode, 8) & 0o777, 'blob': blob}
    return result


def stream_blob(blob, output=None):
    process = subprocess.Popen(['git', 'cat-file', 'blob', blob], stdout=subprocess.PIPE)
    sha = hashlib.sha256()
    try:
        while True:
            part = process.stdout.read(1024 * 1024)
            if not part:
                break
            sha.update(part)
            if output is not None:
                output.write(part)
        if process.wait(timeout=120):
            raise RuntimeError('Git blob failed')
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait()
    return sha.hexdigest()


def build(base, head, output):
    if not all(re.fullmatch('[a-f0-9]{40,64}', sha) for sha in (base, head)):
        raise ValueError('Commit SHAs required')
    before, after = tree(base), tree(head)
    changed = sorted(p for p in after if before.get(p) != after[p])
    deleted = sorted(set(before) - set(after))
    baseline = {p: {'sha256': stream_blob(f['blob']), 'mode': f['mode']} for p, f in before.items()}
    updated = {}
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as package:
        for path in changed:
            with package.open('files/' + path, 'w', force_zip64=True) as dest:
                sha = stream_blob(after[path]['blob'], dest)
            updated[path] = {'sha256': sha, 'mode': after[path]['mode']}
        package.writestr('d2d-update.json', json.dumps({'format': 'd2d-delta-v1', 'base_sha': base, 'head_sha': head,
                         'base_files': baseline, 'files': updated, 'deleted': deleted}, ensure_ascii=False))
    print('Built', len(changed), 'changed files;', len(deleted), 'deleted files')


def build_archives(before_path, after_path, before_root, after_root, base, head, output):
    if not all(re.fullmatch('[a-f0-9]{64}', sha) for sha in (base, head)):
        raise ValueError('Archive SHA-256 required')
    def entries(package, prefix):
        files = {}
        for entry in package.infolist():
            if entry.is_dir():
                continue
            if not entry.filename.startswith(prefix) or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Invalid archive root or symlink')
            path = safe(entry.filename[len(prefix):])
            if path in files:
                raise ValueError('Duplicate archive path')
            digest = hashlib.sha256()
            with package.open(entry) as file:
                for chunk in iter(lambda: file.read(1024 * 1024), b''):
                    digest.update(chunk)
            files[path] = {'entry': entry, 'sha256': digest.hexdigest(), 'mode': 0o755 if (entry.external_attr >> 16) & 0o111 else 0o644}
        return files
    with zipfile.ZipFile(before_path) as old, zipfile.ZipFile(after_path) as new:
        before, after = entries(old, before_root), entries(new, after_root)
        baseline = {p: {'sha256': f['sha256'], 'mode': f['mode']} for p, f in before.items()}
        changed = sorted(p for p in after if p not in before or any(before[p][k] != after[p][k] for k in ('sha256', 'mode')))
        updated = {p: {'sha256': after[p]['sha256'], 'mode': after[p]['mode']} for p in changed}
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as package:
            for path in changed:
                with new.open(after[path]['entry']) as source, package.open('files/' + path, 'w', force_zip64=True) as dest:
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk: break
                        dest.write(chunk)
            package.writestr('d2d-update.json', json.dumps({'format': 'd2d-delta-v1', 'base_sha': base, 'head_sha': head,
                             'base_files': baseline, 'files': updated, 'deleted': sorted(set(before) - set(after))}, ensure_ascii=False))


if __name__ == '__main__':
    if sys.argv[1:2] == ['--archives']:
        build_archives(*sys.argv[2:])
    else:
        build(*sys.argv[1:])
