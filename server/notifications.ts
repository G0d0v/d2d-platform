import type {SQL} from './db.ts';
import {id} from './security.ts';
export async function notify(tx:SQL,project:string,key:string,kind:string,title:string,target:string,exclude:string,recipients?:string[]){
 await tx.query(`INSERT INTO notifications (id,user_id,project_id,event_key,kind,title,target,created_at)
 SELECT $1||m.user_id,m.user_id,m.project_id,$3,$4,$5,$6,$7 FROM members m WHERE m.project_id=$2 AND m.user_id<>$8 ${recipients?'AND m.user_id=ANY($9::text[])':''} ON CONFLICT(user_id,event_key) DO NOTHING`,[id(),project,key,kind,title,target,Date.now(),exclude,...(recipients?[recipients]:[])]);
}
