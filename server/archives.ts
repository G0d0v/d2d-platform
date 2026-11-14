import yauzl from 'yauzl';
import {crc32} from 'node:zlib';
import { Problem } from './security.ts';

export interface ArchiveFile {path:string;size:number;}
export async function inspectArchive(buffer:Buffer, wanted?:string):Promise<{files:ArchiveFile[];root:string;content?:string}> {
  if(buffer.length>25*1024*1024) throw new Problem(413,'ARCHIVE_TOO_LARGE','ZIP-архив не должен превышать 25 МиБ');
  return new Promise((resolve,reject)=>{
    yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true,decodeStrings:true},(error,zip)=>{
      if(error||!zip) return reject(new Problem(422,'INVALID_ARCHIVE','Не удалось прочитать ZIP-архив'));
      let total=0, content:string|undefined, finished=false;
      const files:ArchiveFile[]=[],names=new Set<string>();
      const fail=(e:Error)=>{if(!finished){finished=true;zip.close();reject(e);}};
      zip.on('error',()=>fail(new Problem(422,'INVALID_ARCHIVE','Архив повреждён')));
      zip.on('entry',(entry:yauzl.Entry)=>{
        const path=entry.fileName;
        if(path.includes('\\')||path.startsWith('/')||path.includes('//')||path.includes(':')||path.split('/').some(p=>p==='..'||p==='.')||/[\x00-\x1f]/.test(path)||names.has(path)) return fail(new Problem(422,'UNSAFE_ARCHIVE','Архив содержит небезопасные или повторяющиеся пути'));
        names.add(path);
        const mode=(entry.externalFileAttributes>>>16)&0o170000;
        if(mode===0o120000||entry.generalPurposeBitFlag&1) return fail(new Problem(422,'UNSAFE_ARCHIVE','Символические ссылки и зашифрованные ZIP не поддерживаются'));
        if(path.endsWith('/')) return zip.readEntry();
        if(path.split('/').some(p=>p==='.git'||p==='node_modules'||p==='.env'||p==='id_rsa'||p==='id_ed25519')||/\.(pem|key)$/i.test(path)) return fail(new Problem(422,'SENSITIVE_ARCHIVE','Удалите из архива .env, приватные ключи, .git и node_modules. Файлы .env.example разрешены'));
        total+=entry.uncompressedSize;
        if(files.length>=10000||total>100*1024*1024||entry.uncompressedSize>25*1024*1024) return fail(new Problem(422,'ARCHIVE_LIMIT','Не более 10 000 файлов, 100 МиБ после распаковки и 25 МиБ на файл'));
        files.push({path,size:entry.uncompressedSize});
        const read=wanted===undefined||wanted===path;
        if(!read) return zip.readEntry();
        zip.openReadStream(entry,(e,stream)=>{
          if(e||!stream) return fail(new Problem(422,'INVALID_ARCHIVE','Не удалось распаковать файл'));
          const chunks:Buffer[]=[];let size=0,crc=0;
          stream.on('data',chunk=>{crc=crc32(chunk,crc);size+=chunk.length;if(size>entry.uncompressedSize||size>25*1024*1024){stream.destroy();fail(new Problem(422,'ARCHIVE_LIMIT','Размер распакованного файла превышает лимит'));}else if(wanted===path&&size<=256*1024) chunks.push(chunk);});
          stream.on('error',()=>fail(new Problem(422,'INVALID_ARCHIVE','Архив повреждён')));
          stream.on('end',()=>{if(finished)return;if(crc!==entry.crc32)return fail(new Problem(422,'INVALID_ARCHIVE','Контрольная сумма файла ZIP не совпадает'));if(wanted===path){if(size>256*1024) content='Предпросмотр доступен для файлов до 256 КиБ.';else {const b=Buffer.concat(chunks);content=b.includes(0)?'Двоичный файл. Скачайте архив для просмотра.':b.toString('utf8');}}zip.readEntry();});
        });
      });
      zip.on('end',()=>{
        if(finished)return;finished=true;
        if(!files.length)return reject(new Problem(422,'EMPTY_ARCHIVE','В архиве нет файлов'));
        const first=files[0].path.split('/')[0];const root=files.every(f=>f.path.startsWith(first+'/'))?first+'/':'';
        resolve({files,root,content});
      });
      zip.readEntry();
    });
  });
}
