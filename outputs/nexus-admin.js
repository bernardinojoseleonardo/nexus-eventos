(() => {
  const config=window.NEXUS_CONFIG;
  if(!config?.url||!config?.publishableKey){document.getElementById('loginError').style.display='block';document.getElementById('loginError').textContent='Configuração do servidor indisponível.';return;}
  const api=config.url.replace(/\/$/,'');
  const key='nexusAdminSession';
  let session=null,account=null;
  const $=selector=>document.querySelector(selector);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=value=>`${Number(value||0).toLocaleString('pt-PT',{maximumFractionDigits:2})} Kz`;
  const sessionRead=()=>{try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}};
  const sessionSave=value=>{session=value;if(value)localStorage.setItem(key,JSON.stringify(value));else localStorage.removeItem(key)};
  async function request(path,options={},retry=true){
    const headers=new Headers(options.headers||{});headers.set('apikey',config.publishableKey);headers.set('Authorization',`Bearer ${session?.access_token||config.publishableKey}`);if(options.body)headers.set('Content-Type','application/json');
    let response=await fetch(api+path,{...options,headers});
    if(response.status===401&&retry&&session?.refresh_token){const refresh=await fetch(api+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:config.publishableKey,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:session.refresh_token})});if(refresh.ok){sessionSave(await refresh.json());return request(path,options,false)}sessionSave(null);}
    if(!response.ok){let message='Operação não concluída.';try{const body=await response.json();message=body.message||body.msg||body.error||message}catch{}throw new Error(message)}
    if(response.status===204)return null;const text=await response.text();return text?JSON.parse(text):null;
  }
  async function authenticate(email,password){
    const result=await request('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})},false);
    sessionSave(result);
    const profiles=await request('/rest/v1/profiles?id=eq.'+encodeURIComponent(result.user.id)+'&select=id,full_name,email,role');
    const profile=profiles?.[0];if(profile?.role!=='admin')throw new Error('Esta conta não tem acesso administrativo.');
    account={...profile,email:result.user.email};sessionSave(result);
  }
  async function loadAll(){
    const [profiles,events,orders,reports,settings]=await Promise.all([
      request('/rest/v1/profiles?select=id,full_name,phone,role&order=created_at.asc'),
      request('/rest/v1/events?select=id,title,venue,starts_at,status,organizer_id,ticket_capacity,ticket_price&order=created_at.desc'),
      request('/rest/v1/ticket_orders?select=id,reference,event_id,buyer_id,buyer_name,buyer_email,quantity,total,status,payment_method,payment_reference,paid_at,digital_ticket_code&order=created_at.desc'),
      request('/rest/v1/admin_event_report?select=*'),
      request('/rest/v1/platform_settings?key=eq.commission_percent&select=value')
    ]);
    return {profiles:profiles||[],events:events||[],orders:orders||[],reports:reports||[],commission:Number(settings?.[0]?.value??10)};
  }
  function moneyMethod(method){return {multicaixa_express:'Multicaixa Express',referencia:'Referência',transferencia:'Transferência',cartao:'Cartão',dinheiro:'Dinheiro'}[method]||'Não informado'}
  function render(data){
    const organizerRows=(data.profiles||[]).filter(p=>p.role==='organizer');
    const pendingOrders=data.orders.filter(o=>o.status==='reserved').length;
    const paidOrders=data.orders.filter(o=>o.status==='paid').length;
    const gross=data.orders.filter(o=>o.status==='paid').reduce((s,o)=>s+Number(o.total||0),0);
    $('#metrics').innerHTML=`<div class="metric"><small>Organizadores</small><strong>${organizerRows.length}</strong></div><div class="metric"><small>Eventos</small><strong>${data.events.length}</strong></div><div class="metric"><small>Pagamentos pendentes</small><strong>${pendingOrders}</strong></div><div class="metric"><small>Faturamento pago</small><strong>${money(gross)}</strong></div>`;
    $('#organizerTable').innerHTML=`<table class="table"><thead><tr><th>Organizador</th><th>Telefone</th><th>Estado</th><th>Ações</th></tr></thead><tbody>${organizerRows.length?organizerRows.map(p=>`<tr><td>${esc(p.full_name||'Sem nome')}</td><td>${esc(p.phone||'—')}</td><td><span class="tag pending">Pendente</span></td><td><button class="action approve" data-approve="${esc(p.id)}">Aprovar</button><button class="action suspend" data-suspend="${esc(p.id)}">Suspender</button></td></tr>`).join(''):'<tr><td colspan="4">Nenhum organizador cadastrado.</td></tr>'}</tbody></table>`;
    $('#eventTable').innerHTML=`<table class="table"><thead><tr><th>Evento</th><th>Local</th><th>Lotação</th><th>Estado</th><th>Ações</th></tr></thead><tbody>${data.events.length?data.events.map(e=>`<tr><td>${esc(e.title)}</td><td>${esc(e.venue)}</td><td>${e.ticket_capacity}</td><td><span class="tag ${esc(e.status)}">${esc(e.status)}</span></td><td>${e.status==='draft'?`<button class="action approve" data-publish="${esc(e.id)}">Publicar</button><button class="action reject" data-reject="${esc(e.id)}">Rejeitar</button>`:`<button class="action reject" data-reject="${esc(e.id)}">Cancelar</button>`}</td></tr>`).join(''):'<tr><td colspan="5">Nenhum evento encontrado.</td></tr>'}</tbody></table>`;
    $('#orderTable').innerHTML=`<table class="table"><thead><tr><th>Pedido</th><th>Cliente</th><th>Evento</th><th>Valor</th><th>Método</th><th>Estado</th><th>Ações</th></tr></thead><tbody>${data.orders.length?data.orders.map(o=>`<tr><td><strong>${esc(o.reference)}</strong><br><small>${esc(o.payment_reference||'Sem referência')}</small></td><td>${esc(o.buyer_name||o.buyer_email||'—')}</td><td>${esc(o.event_id)}</td><td>${money(o.total)}</td><td>${esc(moneyMethod(o.payment_method))}</td><td><span class="tag ${esc(o.status)}">${esc(o.status)}</span></td><td>${o.status==='reserved'?`<button class="action pay" data-pay="${esc(o.id)}">Confirmar pagamento</button><button class="action reject" data-cancel-order="${esc(o.id)}">Cancelar</button>`:o.digital_ticket_code?esc(o.digital_ticket_code):'—'}</td></tr>`).join(''):'<tr><td colspan="7">Nenhum pedido encontrado.</td></tr>'}</tbody></table>`;
    $('#overviewContent').innerHTML='<p>A administração privada gere organizadores, eventos, pedidos, pagamentos e emissão de ingressos digitais.</p>';
  }
  async function refresh(){try{render(await loadAll())}catch(error){alert(error.message)}}
  async function start(){
    session=sessionRead();if(!session?.access_token)return;
    try{
      const profiles=await request('/rest/v1/profiles?id=eq.'+encodeURIComponent(session.user.id)+'&select=id,full_name,role');
      if(profiles?.[0]?.role!=='admin'){sessionSave(null);return}
      account={...profiles[0],email:session.user.email};showApp();
    }catch{sessionSave(null)}
  }
  function showApp(){ $('#loginScreen').style.display='none';$('#app').style.display='block';$('#app').classList.add('mobile-ready');$('#adminName').textContent=account.full_name||account.email;refresh();}
  $('#loginForm').addEventListener('submit',async event=>{event.preventDefault();const error=$('#loginError');error.style.display='none';try{await authenticate($('#email').value.trim().toLower(),$('#password').value);showApp()}catch(e){error.style.display='block';error.textContent=e.message}});
  $('#logout').addEventListener('click',()=>{sessionSave(null);location.reload()});
  document.addEventListener('click',async event=>{
    const panel=event.target.closest('[data-panel]');if(panel){document.querySelectorAll('.side-link').forEach(b=>b.classList.remove('active'));panel.classList.add('active');document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));$('#'+panel.dataset.panel).classList.add('active');$('#pageTitle').textContent=panel.textContent.trim();return}
    const pay=event.target.closest('[data-pay]');if(pay){if(!confirm('Confirmar pagamento e emitir ingresso digital?'))return;try{await request('/rest/v1/rpc/issue_paid_ticket',{method:'POST',body:JSON.stringify({p_order_id:pay.dataset.pay})});await refresh()}catch(e){alert(e.message)}return}
    const approve=event.target.closest('[data-approve]');if(approve){try{await request('/rest/v1/rpc/approve_organizer',{method:'POST',body:JSON.stringify({p_user_id:approve.dataset.approve})});await refresh()}catch(e){alert(e.message)}return}
    const suspend=event.target.closest('[data-suspend]');if(suspend){try{await request('/rest/v1/rpc/suspend_organizer',{method:'POST',body:JSON.stringify({p_user_id:suspend.dataset.suspend})});await refresh()}catch(e){alert(e.message)}return}
    const publish=event.target.closest('[data-publish]');if(publish){try{await request('/rest/v1/rpc/review_event',{method:'POST',body:JSON.stringify({p_event_id:publish.dataset.publish,p_status:'published'})});await refresh()}catch(e){alert(e.message)}return}
    const reject=event.target.closest('[data-reject]');if(reject){try{await request('/rest/v1/rpc/review_event',{method:'POST',body:JSON.stringify({p_event_id:reject.dataset.reject,p_status:'cancelled'})});await refresh()}catch(e){alert(e.message)}return}
  });
  start();
})();
