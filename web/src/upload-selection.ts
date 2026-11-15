export interface UploadFile { file: File; path: string }
export interface UploadSelection { files: UploadFile[]; zip?: File }
export const emptySelection = (): UploadSelection => ({ files: [] });

export function excludedUploadPath(path: string): boolean {
  return path.split('/').some(part => ['.git', '.d2d', 'node_modules', '.env', 'id_rsa', 'id_ed25519'].includes(part.toLowerCase())) || /\.(pem|key)$/i.test(path);
}

export function mergeUploadFiles(previous: UploadFile[], incoming: UploadFile[]): { files: UploadFile[]; skipped: string[] } {
  const files = new Map(previous.map(item => [item.path.toLowerCase(), item]));
  const skipped: string[] = [];
  for (const item of incoming) {
    if (excludedUploadPath(item.path)) { skipped.push(item.path); continue; }
    if (!item.path || /[\\:\x00-\x1f\x7f]/.test(item.path) || item.path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
      throw new Error(`Неподдерживаемое имя файла: ${item.path}. Переименуйте файл и выберите его снова.`);
    }
    files.set(item.path.toLowerCase(), item);
    if (files.size > 10000) throw new Error('За один раз можно загрузить до 10 000 файлов. Разделите загрузку на несколько частей.');
  }
  const paths = new Set(files.keys());
  for (const path of paths) {
    const parts = path.split('/');
    for (let end = 1; end < parts.length; end++) {
      if (paths.has(parts.slice(0, end).join('/'))) throw new Error(`«${parts.slice(0, end).join('/')}» выбрано и как файл, и как папка. Уберите один из вариантов.`);
    }
  }
  return { files: [...files.values()], skipped };
}

export function uploadPaths(files: UploadFile[], stripFolder: boolean): UploadFile[] {
  const root = files[0]?.path.split('/')[0];
  const commonFolder = files.length > 0 && files.every(item => item.path.includes('/') && item.path.split('/')[0] === root);
  return stripFolder && commonFolder ? files.map(item => ({ ...item, path: item.path.split('/').slice(1).join('/') })) : files;
}

export async function droppedFiles(transfer: DataTransfer): Promise<UploadFile[]> {
  const result: UploadFile[] = [];
  async function visit(entry: FileSystemEntry, parent = '', depth = 0): Promise<void> {
    const path = parent + entry.name;
    if (excludedUploadPath(path)) { result.push({ path, file: new File([], entry.name) }); return; }
    if (depth > 100) throw new Error('Слишком много вложенных папок. Выберите папку ближе к нужным файлам.');
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      result.push({ path, file });
      if (result.length > 10000) throw new Error('За один раз можно загрузить до 10 000 файлов.');
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // Chromium returns directory entries in batches, usually 100 at a time.
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, path + '/', depth + 1);
      }
    }
  }
  const entries = Array.from(transfer.items ?? []).filter(item => item.kind === 'file').map(item => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  if (!entries.length) return Array.from(transfer.files).map(file => ({ file, path: file.name }));
  for (const { entry, file } of entries) {
    if (entry) await visit(entry);
    else if (file) result.push({ file, path: file.name });
  }
  return result;
}

export function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} Б` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} КБ` : bytes < 1073741824 ? `${(bytes / 1048576).toFixed(1)} МБ` : `${(bytes / 1073741824).toFixed(1)} ГБ`;
}
