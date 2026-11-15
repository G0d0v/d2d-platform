"""Применить пакет D2D: python3 apply-project-update.py update.zip /path/to/source [--check]."""
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import sys
import tempfile
import zipfile


def safe(path):
    if not isinstance(path, str) or not path or re.search(r'[\\:\x00-\x1f\x7f]', path) or any(p in ('', '.', '..') or p.endswith((' ', '.')) for p in path.split('/')):
        raise ValueError('Небезопасный путь в пакете обновления')
    if any(p.lower() in ('.git', '.env', 'id_rsa', 'id_ed25519', 'node_modules') for p in path.split('/')) or path.lower().endswith(('.pem', '.key')):
        raise ValueError('Обновление не должно содержать секреты и служебные каталоги')
    return path


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for part in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(part)
    return digest.hexdigest()


def apply(package_path, source, check=False):
    root = pathlib.Path(source).resolve(strict=True)
    if not root.is_dir() or root == pathlib.Path(root.anchor):
        raise ValueError('Укажите отдельный каталог исходников проекта')

    def target(path):
        current = root
        for part in safe(path).split('/'):
            current = current / part
            if current.is_symlink():
                raise ValueError('Символическая ссылка в пути: ' + path)
        if not current.resolve().is_relative_to(root):
            raise ValueError('Путь вне проекта')
        return current

    with zipfile.ZipFile(package_path) as package:
        if len(package.namelist()) != len(set(package.namelist())):
            raise ValueError('Повторяющиеся пути в ZIP')
        info = package.getinfo('d2d-update.json')
        if info.file_size > 16 * 1024 * 1024:
            raise ValueError('Слишком большое описание обновления')
        manifest = json.loads(package.read(info))
        if manifest.get('format') != 'd2d-delta-v1' or not all(re.fullmatch('[a-f0-9]{40,64}', manifest.get(k, '')) for k in ('base_sha', 'head_sha')):
            raise ValueError('Неверный формат пакета')
        before, updated, deleted = manifest['base_files'], manifest['files'], manifest['deleted']
        if not isinstance(before, dict) or not isinstance(updated, dict) or not isinstance(deleted, list):
            raise ValueError('Неверное описание файлов')
        if set(package.namelist()) != {'d2d-update.json'} | {'files/' + safe(p) for p in updated}:
            raise ValueError('Содержимое ZIP не совпадает с описанием')
        for path in set(before) | set(updated) | set(deleted):
            safe(path)
        for path in before:
            file = target(path)
            if not file.is_file() or sha(file) != before[path]['sha256']:
                raise ValueError('Исходная версия не совпадает или файл изменён локально: ' + path)
        # An existing untracked file must never be silently replaced by a new tracked file.
        for path in updated:
            file = target(path)
            if path not in before and file.exists():
                if file.is_dir():
                    # File/directory transitions are allowed only when all children are tracked deletions.
                    for child in file.rglob('*'):
                        if child.is_symlink() or (child.is_file() and child.relative_to(root).as_posix() not in deleted):
                            raise ValueError('В папке есть локальные файлы: ' + path)
                else:
                    raise ValueError('На месте нового файла уже есть локальный файл: ' + path)
        for path in deleted:
            if path not in before or path in updated:
                raise ValueError('Неверный список удалений')
        # Fully verify payloads before touching the target. Stage and backup are adjacent to the source.
        with tempfile.TemporaryDirectory(prefix='.d2d-update-', dir=root.parent) as temp:
            staging = pathlib.Path(temp) / 'new'; backup = pathlib.Path(temp) / 'old'
            staging.mkdir(); backup.mkdir()
            for index, (path, meta) in enumerate(updated.items()):
                if meta['mode'] not in (0o644, 0o755):
                    raise ValueError('Неверные права файла')
                entry = package.getinfo('files/' + path)
                if stat.S_ISLNK(entry.external_attr >> 16):
                    raise ValueError('Символическая ссылка в ZIP')
                with package.open(entry) as src, (staging / str(index)).open('wb') as dest:
                    shutil.copyfileobj(src, dest, 1024 * 1024)
                if sha(staging / str(index)) != meta['sha256']:
                    raise ValueError('Контрольная сумма не совпала: ' + path)
            if check:
                print('Проверено:', len(updated), 'изменений,', len(deleted), 'удалений; исходники совпадают')
                return manifest
            affected = set(updated) | set(deleted)
            saved = []
            written = []
            try:
                for index, path in enumerate(sorted(affected, key=lambda p: (-p.count('/'), p))):
                    file = target(path)
                    if file.is_file():
                        os.replace(file, backup / str(index)); saved.append((path, index))
                for index, path in enumerate(updated):
                    file = target(path)
                    if file.is_dir():
                        # rmdir only removes empty directories, never untracked data.
                        for parent in sorted(file.rglob('*'), key=lambda p: len(p.parts), reverse=True):
                            if parent.is_dir(): parent.rmdir()
                        file.rmdir()
                    missing = []; parent = file.parent
                    while parent != root and not parent.exists():
                        missing.append(parent); parent = parent.parent
                    file.parent.mkdir(parents=True, exist_ok=True)
                    for parent in missing:
                        parent.chmod(0o755)
                    os.replace(staging / str(index), file); written.append(path)
                    os.chmod(file, updated[path]['mode'])
            except BaseException:
                for path in reversed(written):
                    target(path).unlink(missing_ok=True)
                for path, index in reversed(saved):
                    file = target(path)
                    if file.is_dir(): file.rmdir()
                    file.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(backup / str(index), file)
                raise
    print('Обновлено до', manifest['head_sha'][:12], ':', len(updated), 'файлов; удалено', len(deleted))
    return manifest


if __name__ == '__main__':
    try:
        apply(sys.argv[1], sys.argv[2], '--check' in sys.argv[3:])
    except Exception as error:
        raise SystemExit('Обновление остановлено: ' + str(error)) from None
