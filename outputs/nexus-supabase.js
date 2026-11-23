(() => {
  const config = window.NEXUS_CONFIG;
  if (!config?.url || !config?.publishableKey) {
    console.error('A configuração do Supabase está em falta.');
    return;
  }
  const apiUrl = config.url.replace(/\/$/, '');
  const sessionKey = 'nexusAuthSession';
  let session = readSession();
  let accountId = null;
  const styleFor = category => categoryStyle[category] || categoryStyle.Festas;
  const roleLabel = role => role === 'organizer' ? 'organizador' : role === 'admin' ? 'administrador' : 'participante';
  const currentToken = () => session?.access_token || config.publishableKey;
  function readSession() { try { return JSON.parse(localStorage.getItem(sessionKey) || 'null'); } catch { return null; } }
  function saveSession(value) { session = value; if (value) localStorage.setItem(sessionKey, JSON.stringify(value)); else localStorage.removeItem(sessionKey); }
  async function request(path, options = {}, useAuth = true, retry = true) {
    const headers = new Headers(options.headers || {});
    headers.set('apikey', config.publishableKey);
    headers.set('Authorization', `Bearer ${useAuth ? currentToken() : config.publishableKey}`);
    if (options.body && !(options.body instanceof Blob) && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${apiUrl}${path}`, { ...options, headers });
    if (response.status === 401 && retry && session?.refresh_token) {
      const refreshed = await fetch(`${apiUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      if (refreshed.ok) { saveSession(await refreshed.json()); return request(path, options, useAuth, false); }
      saveSession(null); account = null; accountId = null;
    }
    if (!response.ok) {
      let detail = `Pedido falhou (${response.status}).`;
      try { const body = await response.json(); detail = body.msg || body.message || body.error_description || body.error || detail; } catch {}
      throw new Error(detail);
    }
    if (response.status === 204) return null;
    const text = await response.text(); return text ? JSON.parse(text) : null;
  }
  function showError(message, title = 'Não foi possível concluir') {
    openModal(title, 'Verifique os dados e tente novamente.', `<p class="form-note">${esc(message)}</p><div class="form-actions"><button class="button button-dark" data-close>Entendi</button></div>`);
  }
  async function restoreEmailConfirmation() {
    const params = new URLSearchParams(location.hash.slice(1));
    const accessToken = params.get('access_token');
    if (!accessToken || !['signup', 'email'].includes(params.get('type'))) return false;
    const response = await fetch(`${apiUrl}/auth/v1/user`, {
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) throw new Error('O link expirou ou já foi utilizado. Entre na sua conta ou peça um novo código.');
    const user = await response.json();
    saveSession({ access_token: accessToken, refresh_token: params.get('refresh_token'), token_type: params.get('token_type') || 'bearer', user });
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return true;
  }
  async function loadAccount() {
    if (!session?.user?.id) { account = null; accountId = null; adminSession = false; return; }
    accountId = session.user.id;
    const rows = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(accountId)}&select=id,full_name,phone,role`);
    const profile = rows?.[0];
    if (!profile) throw new Error('O perfil desta conta não foi encontrado.');
    account = { id: profile.id, email: session.user.email || '', name: profile.full_name || '', phone: profile.phone || '', role: roleLabel(profile.role), rawRole: profile.role };
    adminSession = profile.role === 'admin';
    const label = document.querySelector('#accountButton span'); if (label) label.textContent = account ? 'A minha conta' : 'Entrar';
  }
  async function signedImage(path) {
    try {
      const result = await request(`/storage/v1/object/sign/event-images/${path.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST', body: JSON.stringify({ expiresIn: 3600 })
      }, false);
      const location = result.signedURL || result.signedUrl;
      return location?.startsWith('http') ? location : `${apiUrl}/storage/v1${location}`;
    } catch { return ''; }
  }
  function mapEvent(row, images = []) {
    const style = styleFor(row.category), dateValue = row.starts_at ? new Date(row.starts_at).toISOString().slice(0, 16) : '';
    return { id: row.id, title: row.title, category: row.category, date: formatDate(row.starts_at), dateValue,
      place: row.venue, price: Number(row.ticket_price), quantity: Number(row.ticket_capacity), description: row.description || '',
      images, cover: style[0], icon: style[1], tag: style[2], organizer: row.organizer_id, status: row.status };
  }
  async function loadEvents() {
    const rows = await request('/rest/v1/events?select=*,event_images(*)&status=eq.published&order=starts_at.asc', {}, false);
    const mapped = await Promise.all((rows || []).map(async row => {
      const images = await Promise.all((row.event_images || []).sort((a,b) => a.position - b.position).map(async photo => ({
        src: await signedImage(photo.object_path), label: photo.label, path: photo.object_path
      })));
      return mapEvent(row, images.filter(photo => photo.src));
    }));
    customEvents = mapped; seedEvents.splice(0, seedEvents.length); eventOverrides = []; deletedEventIds = [];
    renderEvents();
  }
  async function loadOrders() {
    if (!account) { orders = []; return; }
    const filter = account.rawRole === 'admin' ? '' : `&buyer_id=eq.${encodeURIComponent(account.id)}`;
    const rows = await request(`/rest/v1/ticket_orders?select=*,events(title,venue)&order=created_at.desc${filter}`);
    orders = (rows || []).map(row => ({ reference: row.reference, eventId: row.event_id, eventTitle: row.events?.title || 'Evento',
      email: row.buyer_email || account.email, name: row.buyer_name || account.name, quantity: row.quantity, total: Number(row.total),
      status: row.status, createdAt: row.created_at, paidAt: row.paid_at, id: row.id }));
  }
  function authForm(mode) {
    if (mode === 'register') {
      openModal('Criar conta na NEXUS', 'Registe-se para publicar eventos ou reservar ingressos.', `<form data-form="register"><div class="form-grid">
        <div class="field full"><label for="regName">Nome completo</label><input id="regName" name="name" required maxlength="80"></div>
        <div class="field"><label for="regEmail">E-mail</label><input id="regEmail" name="email" type="email" required maxlength="120"></div>
        <div class="field"><label for="regPhone">Telefone</label><input id="regPhone" name="phone" type="tel" maxlength="30"></div>
        <div class="field full"><label for="regRole">Como pretende usar a plataforma?</label><select id="regRole" name="role"><option value="organizer">Quero anunciar eventos e vender ingressos</option><option value="participant">Quero comprar ingressos</option></select></div>
        <div class="field full"><label for="regPassword">Palavra-passe</label><input id="regPassword" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      </div><p class="form-note">Será usada a autenticação segura do Supabase. Pode ser necessário confirmar o e-mail.</p>
      <div class="form-actions"><button type="button" class="button button-outline" data-auth="login">Já tenho conta</button><button class="button button-dark" type="submit">Criar conta</button></div></form>`);
    } else if (mode === 'verify') {
      openModal('Confirmar o seu e-mail', 'Introduza o código enviado quando criou a sua conta.', `<form data-form="verify-signup"><div class="form-grid"><div class="field full"><label for="signupEmail">E-mail</label><input id="signupEmail" name="email" type="email" required autocomplete="email"></div><div class="field full"><label for="signupToken">Código recebido por e-mail</label><input id="signupToken" name="token" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required placeholder="Introduza o código"></div></div><p class="form-note">Se recebeu um link de confirmação, abra-o diretamente no e-mail.</p><div class="form-actions"><button type="button" class="button button-outline" data-auth="login">Voltar a entrar</button><button class="button button-dark" type="submit">Confirmar e-mail</button></div></form>`);
    } else {
      openModal('Entrar na NEXUS', 'Aceda à sua conta de participante ou organizador.', `<form data-form="login"><div class="form-grid">
        <div class="field full"><label for="loginEmail">E-mail</label><input id="loginEmail" name="email" type="email" required autocomplete="email"></div>
        <div class="field full"><label for="loginPassword">Palavra-passe</label><input id="loginPassword" name="password" type="password" required autocomplete="current-password"></div>
      </div><div class="form-actions"><button type="button" class="button button-outline" data-auth="register">Criar conta</button><button type="button" class="button button-outline" data-auth="verify">Inserir código</button><button class="button button-dark" type="submit">Entrar</button></div></form>`);
    }
  }
  openRegistration = () => authForm('register');
  function openLogin() { authForm('login'); }
  openDashboard = async () => {
    if (!account) { openLogin(); return; }
    try {
      await loadOrders();
      const own = customEvents.filter(item => item.organizer === account.id);
      const mine = orders.filter(item => account.rawRole === 'admin' || item.email === account.email);
      let content = `<div class="account-summary"><div class="avatar">${esc(account.name.split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase())}</div><div><strong>${esc(account.name)}</strong><small>${esc(account.email)} · ${esc(account.role)}</small></div></div>`;
      if (account.rawRole === 'organizer' || account.rawRole === 'admin') content += `<h3 class="report-heading">Os seus eventos</h3>${own.length ? `<div class="dashboard-list">${own.map(item=>`<div class="dashboard-item"><strong>${esc(item.title)}</strong><span>${money(item.price)} · ${esc(item.place)}</span></div>`).join('')}</div>` : '<p class="form-note">Ainda não publicou eventos.</p>'}<button class="button button-dark" data-action="publish">Criar evento</button>`;
      if (mine.length) content += `<h3 class="report-heading">As suas reservas</h3><div class="dashboard-list">${mine.map(item=>`<div class="dashboard-item"><strong>${esc(item.eventTitle)}</strong><span>${item.quantity} ingresso(s) · ${esc(item.reference)} · ${esc(item.status)}</span></div>`).join('')}</div>`;
      content += `<div class="form-actions"><button class="button button-outline" data-action="logout">Sair da conta</button></div>`;
      openModal('A sua conta', 'Dados e atividade guardados na plataforma.', content);
    } catch (error) { showError(error.message); }
  };
  publishEvent = () => {
    if (!account) { openLogin(); return; }
    if (!['organizer','admin'].includes(account.rawRole)) {
      openModal('Perfil de organizador', 'Anuncie eventos com uma conta de organizador.', `<p class="form-note">A sua conta está registada como participante. Termine a sessão e crie uma conta de organizador para publicar eventos.</p><div class="form-actions"><button class="button button-outline" data-close>Fechar</button><button class="button button-dark" data-action="logout-register">Criar conta de organizador</button></div>`); return;
    }
    pendingEventImages = [];
    openModal('Publicar um evento', 'O evento e os seus flyers serão guardados na plataforma.', `<form data-form="event"><div class="form-grid">
      <div class="field full"><label for="eventTitle">Nome do evento</label><input id="eventTitle" name="title" required maxlength="90"></div>
      <div class="field"><label for="eventCategory">Categoria</label><select id="eventCategory" name="category"><option>Casamentos</option><option>Festas</option><option>Música</option><option>Cultura</option><option>Lifestyle</option></select></div>
      <div class="field"><label for="eventDate">Data e hora</label><input id="eventDate" name="date" type="datetime-local" required></div>
      <div class="field full"><label for="eventPlace">Local</label><input id="eventPlace" name="place" required maxlength="100"></div>
      <div class="field"><label for="eventPrice">Preço por ingresso (Kz)</label><input id="eventPrice" name="price" type="number" min="0" step="500" value="5000" required></div>
      <div class="field"><label for="eventQuantity">Quantidade</label><input id="eventQuantity" name="quantity" type="number" min="1" max="100000" value="100" required></div>
      <div class="field full"><label for="eventImage">Flyers e fotografias (até 5)</label><input id="eventImage" name="images" type="file" multiple accept="image/jpeg,image/png,image/webp"><span class="help">JPG, PNG ou WEBP, até 10 MB por imagem.</span><div class="upload-gallery" id="eventImagePreview"></div><span class="help" id="uploadMessage" aria-live="polite"></span></div>
      <div class="field full"><label for="eventDescription">Descrição</label><textarea id="eventDescription" name="description" maxlength="500"></textarea></div></div>
      <p class="form-note">As reservas são registadas como pendentes. Pagamentos online ainda não estão integrados.</p><div class="form-actions"><button type="button" class="button button-outline" data-close>Cancelar</button><button class="button button-dark" type="submit">Publicar evento</button></div></form>`);
  };
  async function uploadImages(eventId, images) {
    let position = 0;
    for (const photo of images) {
      if (photo.path) { position++; continue; }
      const [meta, encoded] = photo.src.split(',');
      const mime = meta.match(/data:(.*?);base64/)?.[1] || 'image/jpeg';
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      const objectPath = `${account.id}/${eventId}/${crypto.randomUUID()}.jpg`;
      await request(`/storage/v1/object/event-images/${objectPath.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST', headers: { 'Content-Type': mime, 'x-upsert': 'false' }, body: new Blob([bytes], {type:mime})
      });
      await request('/rest/v1/event_images', { method:'POST', headers:{Prefer:'return=minimal'}, body:JSON.stringify({event_id:eventId,object_path:objectPath,label:photo.label,position}) });
      position++;
    }
  }
  async function saveEvent(data, eventId = null) {
    const old = eventId ? allEvents().find(item=>item.id===eventId) : null;
    const payload = { title:data.title.trim(), category:data.category, starts_at:new Date(data.date).toISOString(), venue:data.place.trim(),
      description:(data.description||'').trim(), ticket_price:Number(data.price), ticket_capacity:Number(data.quantity), status:'published' };
    let rows;
    if (old) rows = await request(`/rest/v1/events?id=eq.${encodeURIComponent(eventId)}`, { method:'PATCH', headers:{Prefer:'return=representation'}, body:JSON.stringify(payload) });
    else rows = await request('/rest/v1/events', { method:'POST', headers:{Prefer:'return=representation'}, body:JSON.stringify({...payload,organizer_id:account.id}) });
    const saved = rows?.[0];
    if (!saved) throw new Error('O evento não foi guardado. Confirme se a sua conta tem acesso de organizador.');
    await uploadImages(saved.id, pendingEventImages);
    pendingEventImages = [];
    await loadEvents(); modal.close(); document.getElementById('eventos').scrollIntoView({behavior:'smooth'});
    showConfirmation(old?'Evento atualizado':'Evento publicado', old?'As alterações foram guardadas':'O evento já está na plataforma', `EV-${saved.id.slice(0,6).toUpperCase()}`);
  }
  openCheckoutForm = event => {
    selectedEvent = event;
    openModal('Reservar ingresso', `${event.title} · ${event.place}`, `<form data-form="checkout"><div class="form-grid">
      <div class="field full"><label>E-mail do participante</label><input value="${esc(account?.email||'')}" disabled></div>
      <div class="field"><label for="ticketQty">Quantidade</label><select id="ticketQty" name="quantity">${[1,2,3,4,5].map(n=>`<option>${n}</option>`).join('')}</select></div>
      <div class="field"><label>Total estimado</label><input id="orderTotal" value="${money(event.price)}" disabled></div></div>
      <p class="form-note">A reserva fica pendente. Nenhum pagamento será cobrado nesta etapa.</p><div class="form-actions"><button type="button" class="button button-outline" data-close>Cancelar</button><button class="button button-dark" type="submit">Confirmar reserva</button></div></form>`);
    modalBody.querySelector('#ticketQty').addEventListener('change',e=>{modalBody.querySelector('#orderTotal').value=money(event.price*Number(e.target.value));});
  };
  checkout = event => { selectedEvent = event; if (!account) { openLogin(); return; } openCheckoutForm(event); };
  showConfirmation = (title,message,reference) => openModal(title,'',`<div class="success-box"><svg class="icon"><use href="#i-ticket"/></svg><h3>${esc(message)}</h3><p>Guarde esta referência para consultar a reserva.</p><span class="ticket-reference">${esc(reference)}</span></div><div class="form-actions"><button class="button button-dark" data-close>Concluir</button></div>`);
  async function adminPanel() {
    if (account?.rawRole !== 'admin') { openLogin(); return; }
    try {
      const [reports, settings] = await Promise.all([
        request('/rest/v1/admin_event_report?select=*&order=starts_at.desc'),
        request('/rest/v1/platform_settings?key=eq.commission_percent&select=value')
      ]);
      commissionRate = Number(settings?.[0]?.value ?? 10);
      await loadOrders();
      const sold = reports.reduce((sum,row)=>sum+Number(row.tickets_sold||0),0), reserved=reports.reduce((sum,row)=>sum+Number(row.tickets_reserved||0),0);
      const gross=reports.reduce((sum,row)=>sum+Number(row.confirmed_gross||0),0), nexus=gross*commissionRate/100;
      const rows=reports.length?reports.map(row=>`<tr><td><strong>${esc(row.title)}</strong></td><td>${row.tickets_sold}</td><td>${row.tickets_reserved}</td><td>${currency(row.confirmed_gross)}</td><td>${currency(row.reserved_gross)}</td><td>${currency(Number(row.confirmed_gross)*commissionRate/100)}</td><td>${currency(Number(row.reserved_gross)*commissionRate/100)}</td><td>${currency(Number(row.confirmed_gross)*(1-commissionRate/100))}</td><td><div class="admin-actions"><button data-edit-event="${esc(row.event_id)}">Editar</button><button class="danger" data-delete-event="${esc(row.event_id)}">Cancelar</button></div></td></tr>`).join(''):'<tr><td colspan="9">Ainda não há eventos para gerir.</td></tr>';
      const recent=orders.slice(0,30).map(order=>`<div class="dashboard-item"><div><strong>${esc(order.eventTitle)}</strong><span style="display:block;margin-top:4px">${esc(order.email)} · ${order.quantity} ingresso(s) · ${esc(order.reference)}</span></div>${order.status==='paid'?'<strong>Pago</strong>':order.status==='reserved'?`<button class="button button-dark" data-mark-paid="${esc(order.reference)}">Confirmar pagamento</button>`:esc(order.status)}</div>`).join('')||'<p class="form-note">Ainda não há reservas.</p>';
      openModal('Painel de administração','Relatório ligado aos dados confirmados no Supabase.',`<div class="report-summary"><div class="metric"><small>Eventos</small><strong>${reports.length}</strong></div><div class="metric"><small>Ingressos pagos</small><strong>${sold}</strong></div><div class="metric"><small>Ingressos reservados</small><strong>${reserved}</strong></div><div class="metric"><small>Faturamento confirmado</small><strong>${currency(gross)}</strong></div><div class="metric"><small>Receita NEXUS</small><strong>${currency(nexus)}</strong></div></div><p class="report-note">Reservas não são pagamentos. Só marque uma reserva como paga após confirmar o recebimento. Pagamentos online ainda não estão integrados.</p><div class="commission-control"><div class="field"><label for="commissionRate">Comissão NEXUS (%)</label><input id="commissionRate" type="number" min="0" max="100" step="0.5" value="${commissionRate}"></div><button class="button button-dark" data-action="save-commission">Guardar comissão</button><button class="button button-outline" data-action="export-report">Baixar relatório CSV</button><button class="button button-outline" data-action="admin-new">Novo evento</button><button class="button button-outline" data-action="admin-logout">Sair</button></div><h3 class="report-heading">Relatório por evento</h3><div class="report-table-wrap"><table class="report-table"><thead><tr><th>Evento</th><th>Pagos</th><th>Reservas</th><th>Faturamento</th><th>Valor reservado</th><th>NEXUS recebido</th><th>NEXUS estimado</th><th>Organizador</th><th>Gerir</th></tr></thead><tbody>${rows}</tbody></table></div><h3 class="report-heading">Reservas recentes</h3><div class="reservation-list">${recent}</div>`);
    } catch (error) { showError(error.message, 'Painel administrativo'); }
  }
  window.adminPanel = adminPanel;
  window.adminAccess = () => account?.rawRole === 'admin' ? adminPanel() : openLogin();
  confirmOrderPayment = reference => {
    if (account?.rawRole !== 'admin') return;
    const order=orders.find(item=>item.reference===reference); if(!order)return;
    openModal('Confirmar pagamento','Confirme apenas depois de verificar o recebimento.',`<p class="form-note">Marcar como pago: <strong>${esc(order.eventTitle)}</strong>, ${order.quantity} ingresso(s), total ${currency(order.total)}.</p><div class="form-actions"><button class="button button-outline" data-close>Cancelar</button><button class="button button-dark" data-confirm-paid="${esc(reference)}">Confirmar recebimento</button></div>`);
  };
  confirmDeleteEvent = id => {
    if(account?.rawRole!=='admin')return;const item=allEvents().find(event=>event.id===id);if(!item)return;
    openModal('Cancelar evento','O histórico de reservas será preservado.',`<p class="form-note">Cancelar <strong>${esc(item.title)}</strong>? O evento deixa de aparecer publicamente; os registos financeiros permanecem.</p><div class="form-actions"><button class="button button-outline" data-close>Voltar</button><button class="button button-dark" data-confirm-delete="${esc(id)}">Cancelar evento</button></div>`);
  };
  function renderEvents() {
    const shown=customEvents.filter(event=>(activeCategory==='Todos'||event.category===activeCategory)&&`${event.title} ${event.place} ${event.category}`.toLowerCase().includes(query.toLowerCase()));
    count.textContent=`${shown.length} ${shown.length===1?'evento':'eventos'} publicados`;
    grid.innerHTML=shown.length?shown.map(event=>{const photos=galleryFor(event),cover=photos[0]?.src;return `<article class="event-card"><button type="button" class="event-cover ${esc(event.cover)}${cover?' has-photo':''}" data-view-event="${esc(event.id)}" aria-label="Abrir detalhes e galeria de ${esc(event.title)}">${cover?`<img class="cover-photo" src="${esc(cover)}" alt="">`:''}<span class="cover-category">${esc(event.tag)}</span><svg class="icon cover-icon"><use href="#${esc(event.icon)}"/></svg><span class="cover-date">${esc(event.date)}</span></button><div class="event-info"><div class="event-place"><svg class="icon"><use href="#i-pin"/></svg>${esc(event.place)}</div><h3 class="event-title">${esc(event.title)}</h3><div class="event-bottom"><div><span class="price-label">A partir de</span><span class="price">${money(event.price)}</span></div><div class="card-actions"><button class="ticket-button" data-buy="${esc(event.id)}">Ingressos <svg class="icon"><use href="#i-arrow"/></svg></button></div></div></div></article>`}).join(''):'<div class="empty-state">Ainda não há eventos publicados. Volte em breve para descobrir novas experiências.</div>';
  }
  window.renderEvents = renderEvents;
  document.addEventListener('click', async event => {
    const actionTarget=event.target.closest('[data-action]'), action=actionTarget?.dataset.action;
    const auth=event.target.closest('[data-auth]')?.dataset.auth;
    if(auth){event.preventDefault();event.stopImmediatePropagation();authForm(auth);return;}
    if(event.target.closest('[data-action="account"]')){event.preventDefault();event.stopImmediatePropagation();account?openDashboard():openLogin();return;}
    if(event.target.closest('[data-action="publish"]')||['admin-new'].includes(action)){event.preventDefault();event.stopImmediatePropagation();publishEvent();return;}
    if(action==='admin'){event.preventDefault();event.stopImmediatePropagation();adminPanel();return;}
    if(action==='admin-logout'||action==='logout'){event.preventDefault();event.stopImmediatePropagation();try{await request('/auth/v1/logout',{method:'POST'});}catch{}saveSession(null);account=null;accountId=null;adminSession=false;orders=[];document.querySelector('#accountButton span').textContent='Entrar';modal.close();return;}
    if(action==='logout-register'){event.preventDefault();event.stopImmediatePropagation();saveSession(null);account=null;accountId=null;modal.close();openRegistration();return;}
    if(action==='save-commission'){event.preventDefault();event.stopImmediatePropagation();const rate=Number(modalBody.querySelector('#commissionRate')?.value);if(!Number.isFinite(rate)||rate<0||rate>100)return;try{await request('/rest/v1/platform_settings?key=eq.commission_percent',{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({value:rate})});await adminPanel();}catch(error){showError(error.message);}return;}
    if(action==='export-report'){event.preventDefault();event.stopImmediatePropagation();downloadReport();return;}
    const edit=event.target.closest('[data-edit-event]');if(edit){event.preventDefault();event.stopImmediatePropagation();editManagedEvent(edit.dataset.editEvent);return;}
    const cancel=event.target.closest('[data-delete-event]');if(cancel){event.preventDefault();event.stopImmediatePropagation();confirmDeleteEvent(cancel.dataset.deleteEvent);return;}
    const confirmed=event.target.closest('[data-confirm-delete]');if(confirmed){event.preventDefault();event.stopImmediatePropagation();try{await request(`/rest/v1/events?id=eq.${encodeURIComponent(confirmed.dataset.confirmDelete)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'cancelled'})});modal.close();await loadEvents();await adminPanel();}catch(error){showError(error.message);}return;}
    const mark=event.target.closest('[data-mark-paid]');if(mark){event.preventDefault();event.stopImmediatePropagation();confirmOrderPayment(mark.dataset.markPaid);return;}
    const paid=event.target.closest('[data-confirm-paid]');if(paid){event.preventDefault();event.stopImmediatePropagation();const order=orders.find(row=>row.reference===paid.dataset.confirmPaid);if(!order)return;try{await request(`/rest/v1/ticket_orders?id=eq.${encodeURIComponent(order.id)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'paid',paid_at:new Date().toISOString()})});modal.close();await adminPanel();}catch(error){showError(error.message);}return;}
    const view=event.target.closest('[data-view-event]');if(view){event.preventDefault();event.stopImmediatePropagation();showEventDetails(view.dataset.viewEvent);return;}
    const buy=event.target.closest('[data-buy]');if(buy){event.preventDefault();event.stopImmediatePropagation();const item=allEvents().find(row=>row.id===buy.dataset.buy);if(item)checkout(item);return;}
  }, true);
  document.addEventListener('submit', async event => {
    const form=event.target.closest('form[data-form]');if(!form)return;
    const kind=form.dataset.form;if(!['register','verify-signup','login','event','edit-event','checkout'].includes(kind))return;
    event.preventDefault();event.stopImmediatePropagation();const data=Object.fromEntries(new FormData(form));
    try{
      if(kind==='register'){
        const email=data.email.trim().toLowerCase();
        const result=await request('/auth/v1/signup',{method:'POST',body:JSON.stringify({email,password:data.password,data:{full_name:data.name.trim(),phone:data.phone.trim(),role:data.role}})},false);
        if(result.access_token){saveSession(result);await loadAccount();await loadEvents();modal.close();account.rawRole==='organizer'?publishEvent():await openDashboard();}
        else openModal('Confirme o seu e-mail','Enviámos um código de confirmação para o seu endereço.',`<form data-form="verify-signup"><div class="field full"><label for="signupEmail">E-mail</label><input id="signupEmail" name="email" type="email" value="${esc(email)}" required readonly></div><div class="field full"><label for="signupToken">Código recebido por e-mail</label><input id="signupToken" name="token" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required placeholder="Introduza o código"></div><p class="form-note">Se a mensagem tiver um botão ou link de confirmação, também pode abri-lo. Não precisa de inserir o código quando usar o link.</p><div class="form-actions"><button type="button" class="button button-outline" data-auth="login">Já confirmei · Entrar</button><button class="button button-dark" type="submit">Confirmar e-mail</button></div></form>`);
      } else if(kind==='verify-signup'){
        const result=await request('/auth/v1/verify',{method:'POST',body:JSON.stringify({email:data.email.trim().toLowerCase(),token:data.token.trim(),type:'signup'})},false);
        if(!result.access_token)throw new Error('O código não confirmou a conta. Verifique-o ou abra o link recebido por e-mail.');
        saveSession(result);await loadAccount();await loadEvents();modal.close();account.rawRole==='organizer'?publishEvent():await openDashboard();
      } else if(kind==='login'){
        const result=await request('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email:data.email.trim().toLowerCase(),password:data.password})},false);
        saveSession(result);await loadAccount();await loadEvents();modal.close();await openDashboard();
      } else if(kind==='event'||kind==='edit-event'){
        const id=kind==='edit-event'?form.dataset.eventId:null;await saveEvent(data,id);
      } else if(kind==='checkout'){
        if(!account||!selectedEvent)throw new Error('Entre na sua conta antes de reservar.');
        const quantity=Number(data.quantity||1);
        const result=await request('/rest/v1/ticket_orders',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({event_id:selectedEvent.id,buyer_id:account.id,buyer_email:account.email,buyer_name:account.name,quantity,unit_price:selectedEvent.price})});
        const order=result?.[0];if(!order)throw new Error('A reserva não foi criada.');
        orders=[{id:order.id,reference:order.reference,eventId:selectedEvent.id,eventTitle:selectedEvent.title,email:account.email,quantity,total:Number(order.total),status:order.status},...orders];
        modal.close();showConfirmation('Reserva registada',`${quantity} ingresso(s) reservado(s)`,order.reference);
      }
    }catch(error){showError(error.message);}
  }, true);
  async function initialize(){
    try{await restoreEmailConfirmation();if(session){await loadAccount();}await loadEvents();if(account)await loadOrders();}
    catch(error){console.error('NEXUS/Supabase:',error);showError(error.message,'Ligação à plataforma');}
  }
  initialize();
})();

