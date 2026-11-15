import {useState} from 'react';
const command='curl -fsSL https://raw.githubusercontent.com/G0d0v/d2d-platform/main/update.sh | sudo bash';
export function PlatformUpdate(){
 const [copied,setCopied]=useState(false),[error,setError]=useState('');
 return <section className="platform-update"><h3>Установить или обновить D2D на своём сервере</h3><p>Обновление установленной платформы с резервной копией:</p><pre>{command}</pre><button className="button small" onClick={async()=>{try{await navigator.clipboard.writeText(command);setCopied(true);setError('');}catch{setError('Выделите и скопируйте команду вручную.');}}}>{copied?'Скопировано':'Скопировать команду обновления'}</button>{error&&<p role="status">{error}</p>}<p><a href="https://github.com/G0d0v/d2d-platform#установка-одной-командой" target="_blank" rel="noreferrer">Первая установка и требования к серверу</a> · <a href="https://github.com/G0d0v/d2d-platform/releases" target="_blank" rel="noreferrer">История релизов и отдельные файлы</a></p></section>;
}
