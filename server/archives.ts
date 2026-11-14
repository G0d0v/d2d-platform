import yauzl from 'yauzl';
import {crc32} from 'node:zlib';
import { Problem } from './security.ts';
import type { Readable } from 'node:stream';

export async function archiveFileStream(filename:string,path:string):Promise<Readable>{
  return new Promise((resolve,reject)=>yauzl.open(filename,{lazyEntries:true},(error,zip)=>{
    if(error||!zip)return reject(new Problem(422,'INVALID_ARCHIVE','Не удалось прочитать ZIP-архив'));
    zip.on('error',reject);
    zip.on('end',()=>reject(new Problem(404,'NOT_FOUND','Файл не найден')));
    zip.on('entry',entry=>{
      if(entry.fileName!==path){zip.readEntry();return;}
      zip.openReadStream(entry,(e,stream)=>{
        if(e||!stream){zip.close();reject(new Problem(422,'INVALID_ARCHIVE','Не удалось прочитать файл'));return;}
        stream.once('close',()=>zip.close());resolve(stream);
      });
    });
    zip.readEntry();
  }));
}

export interface ArchiveFile {path:string;size:number;}
export async function inspectArchive(buffer:Buffer|string, wanted?:string):Promise<{files:ArchiveFile[];root:string;content?:string}> {
  return new Promise((resolve,reject)=>{
    const opened=(error:Error|null,zip?:yauzl.ZipFile)=>{
      if(error||!zip) return reject(new Problem(422,'INVALID_ARCHIVE','Не удалось прочитать ZIP-архив'));
      let content:string|undefined, finished=false;
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
        if(files.length>=10000) return fail(new Problem(422,'ARCHIVE_LIMIT','Не более 10 000 файлов в архиве'));
        files.push({path,size:entry.uncompressedSize});
        const read=wanted===undefined||wanted===path;
        if(!read) return zip.readEntry();
        zip.openReadStream(entry,(e,stream)=>{
          if(e||!stream) return fail(new Problem(422,'INVALID_ARCHIVE','Не удалось распаковать файл'));
          const chunks:Buffer[]=[];let size=0,crc=0;
          stream.on('data',chunk=>{crc=crc32(chunk,crc);size+=chunk.length;if(size>entry.uncompressedSize){stream.destroy();fail(new Problem(422,'INVALID_ARCHIVE','Размер файла не совпадает с описанием ZIP'));}else if(wanted===path&&size<=256*1024) chunks.push(chunk);});
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
    };
    const options={lazyEntries:true,validateEntrySizes:true,decodeStrings:true};
    if(typeof buffer==='string')yauzl.open(buffer,options,opened);else yauzl.fromBuffer(buffer,options,opened);
  });
}
