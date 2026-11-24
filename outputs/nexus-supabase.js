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
  let authIntent = null;
  let pendingEventVideos = [];
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
  async function restoreAuthCallback() {
    const params = new URLSearchParams(location.hash.slice(1));
    const accessToken = params.get('access_token');
    const callbackType = params.get('type');
    if (!accessToken || !['signup', 'email', 'recovery'].includes(callbackType)) return null;
    const response = await fetch(`${apiUrl}/auth/v1/user`, {
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) throw new Error('O link expirou ou já foi utilizado. Entre na sua conta ou peça um novo código.');
    const user = await response.json();
    saveSession({ access_token: accessToken, refresh_token: params.get('refresh_token'), token_type: params.get('token_type') || 'bearer', user });
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return callbackType;
  }
  async function loadAccount() {
    if (!session?.user?.id) { account = null; accountId = null; adminSession = false; return; }
    accountId = session.user.id;
    const rows = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(accountId)}&select=id,full_name,phone,role,profile_photo_path`);
    const profile = rows?.[0];
    if (!profile) throw new Error('O perfil desta conta não foi encontrado.');
    const email = session.user.email || '';
    const fallbackName = session.user.user_metadata?.full_name || email.split('@')[0] || 'Conta';
    const profilePhotoPath = profile.profile_photo_path || '';
    const identitySubmitted = profile.role !== 'admin' ? await request('/rest/v1/rpc/has_organizer_bi',{method:'POST',body:'{}'}) : false;
    account = { id: profile.id, email, name: profile.full_name || fallbackName, profileHasName:Boolean(profile.full_name||session.user.user_metadata?.full_name), phone: profile.phone || '', role: roleLabel(profile.role), rawRole: profile.role,
      identitySubmitted: Boolean(identitySubmitted), organizerStatus: null, profilePhotoPath,
      profilePhotoUrl: profilePhotoPath ? publicProfilePhoto(profilePhotoPath) : '' };
    adminSession = profile.role === 'admin';
    const label = document.querySelector('#accountButton span'); if (label) label.textContent = account?.name || 'Entrar';
    const logout = document.getElementById('logoutButton'); if (logout) logout.style.display = account ? 'inline-flex' : 'none';
  }
  function publicProfilePhoto(path) {
    return `${apiUrl}/storage/v1/object/public/organizer-profile-photos/${path.split('/').map(encodeURIComponent).join('/')}`;
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
  async function signedEventMedia(path) {
    try {
      const result = await request(`/storage/v1/object/sign/event-media/${path.split('/').map(encodeURIComponent).join('/')}`, {
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
      organizerName: row.organizer_name || '', organizerPhone: row.organizer_phone || '', organizerPhotoUrl: row.organizer_photo_url || '',
      images, cover: style[0], icon: style[1], tag: style[2], organizer: row.organizer_id, status: row.status };
  }
  async function loadEvents() {
    const rows = await request('/rest/v1/events?select=*,event_images(*),event_media(*)&status=eq.published&order=starts_at.asc', {}, false);
    let availability = new Map();
    try {
      const availabilityRows = await request('/rest/v1/rpc/get_public_event_availability', { method: 'POST', body: '{}' }, false);
      availability = new Map((availabilityRows || []).map(row => [row.event_id, Number(row.remaining_quantity)]));
    } catch (error) {
      console.warn('Disponibilidade pública ainda não está disponível no banco:', error.message);
    }
    const mapped = await Promise.all((rows || []).map(async row => {
      const images = await Promise.all((row.event_images || []).sort((a,b) => a.position - b.position).map(async photo => ({
        src: await signedImage(photo.object_path), label: photo.label, path: photo.object_path
      })));
      const videos = await Promise.all((row.event_media || []).filter(media => media.media_type === 'video').sort((a,b) => a.position - b.position).map(async media => ({
        src: await signedEventMedia(media.object_path), label: media.label || 'Vídeo do evento', path: media.object_path, type: 'video'
      })));
      const event = mapEvent(row, [...images.filter(photo => photo.src), ...videos.filter(video => video.src)]);
      event.remaining = availability.has(event.id) ? availability.get(event.id) : event.quantity;
      return event;
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
      status: row.status, createdAt: row.created_at, paidAt: row.paid_at, id: row.id,
      paymentMethod: row.payment_method || '', paymentReference: row.payment_reference || '',
      digitalTicketCode: row.digital_ticket_code || '', ticketIssuedAt: row.ticket_issued_at || '' }));
  }
  async function loadEventSocial(eventId) {
    const [likes, myLikes, comments] = await Promise.all([
      request('/rest/v1/event_likes?select=user_id&event_id=eq.'+encodeURIComponent(eventId), {}, false).catch(()=>[]),
      account ? request('/rest/v1/event_likes?select=user_id&event_id=eq.'+encodeURIComponent(eventId)+'&user_id=eq.'+encodeURIComponent(account.id), {}, true).catch(()=>[]) : Promise.resolve([]),
      request('/rest/v1/event_comments?select=id,user_id,author_name,content,created_at&event_id=eq.'+encodeURIComponent(eventId)+'&status=eq.visible&order=created_at.desc&limit=100', {}, false).catch(()=>[])
    ]);
    return { likeCount:(likes||[]).length, liked:Boolean(myLikes?.length), comments:comments||[] };
  }
  async function toggleEventLike(eventId) {
    if (!account) { authIntent='social'; openLogin(); return null; }
    const social=await loadEventSocial(eventId);
    await request('/rest/v1/rpc/toggle_event_like',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({p_event_id:eventId})});
    return loadEventSocial(eventId);
  }
  async function submitEventComment(eventId, content) {
    if (!account) { authIntent='social'; openLogin(); return null; }
    const clean=content.trim();
    if (clean.length < 1 || clean.length > 500) throw new Error('Escreva um comentário entre 1 e 500 caracteres.');
    await request('/rest/v1/rpc/add_event_comment',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({p_event_id:eventId,p_content:clean})});
    return loadEventSocial(eventId);
  }
  function authForm(mode) {
    if (mode === 'register-participant' || mode === 'register-organizer') {
      const role = mode === 'register-organizer' ? 'organizer' : 'participant';
      openModal('Criar conta', role==='organizer'?'Crie a sua conta; o cadastro de organizador requer aprovação.':'Crie a sua conta para comprar ingressos e reservar lugares.', `<form data-form="register"><input type="hidden" name="role" value="${role}"><div class="form-grid">
        <div class="field full"><label for="regName">Nome completo</label><input id="regName" name="name" required maxlength="80"></div>
        <div class="field"><label for="regEmail">E-mail</label><input id="regEmail" name="email" type="email" required maxlength="120"></div>
        <div class="field"><label for="regPhone">Telefone</label><input id="regPhone" name="phone" type="tel" maxlength="30"></div>
        <div class="field full"><label for="regPassword">Palavra-passe</label><input id="regPassword" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      </div><p class="form-note">Será usada a autenticação segura do Supabase. Pode ser necessário confirmar o e-mail.</p>
      <div class="form-actions"><button type="button" class="button button-outline" data-auth="login">Já tenho conta</button><button class="button button-dark" type="submit">Criar conta</button></div></form>`);
    } else if (mode === 'recover') {
      openModal('Recuperar palavra-passe', 'Enviaremos um link para o e-mail da sua conta.', `<form data-form="password-recovery-request"><div class="field full"><label for="recoveryEmail">E-mail</label><input id="recoveryEmail" name="email" type="email" required autocomplete="email"></div><div class="form-actions"><button type="button" class="button button-outline" data-auth="login">Voltar</button><button class="button button-dark" type="submit">Enviar link</button></div></form>`);
    } else {
      const roleChoices = '<button type="button" class="button button-outline" data-auth="register-participant">Criar conta como participante</button><button type="button" class="button button-outline" data-auth="register-organizer">Criar conta como organizador</button>';
      openModal('Entrar na NEXUS', authIntent === 'publish' ? 'Entre na sua conta para publicar o evento.' : authIntent === 'checkout' ? 'Entre na sua conta para comprar ingressos.' : 'Entre na sua conta para aceder à plataforma.', `<form data-form="login"><div class="form-grid">
        <div class="field full"><label for="loginEmail">E-mail</label><input id="loginEmail" name="email" type="email" required autocomplete="email"></div>
        <div class="field full"><label for="loginPassword">Palavra-passe</label><input id="loginPassword" name="password" type="password" required autocomplete="current-password"></div>
      </div><div class="form-actions">${roleChoices}<button type="button" class="button button-outline" data-auth="recover">Esqueci a palavra-passe</button><button class="button button-dark" type="submit">Entrar</button></div></form>`);
    }
  }
  function openPasswordResetForm() {
    openModal('Criar nova palavra-passe', 'Escolha uma palavra-passe com pelo menos 8 caracteres.', `<form data-form="password-update"><div class="field full"><label for="newPassword">Nova palavra-passe</label><input id="newPassword" name="password" type="password" minlength="8" autocomplete="new-password" required></div><div class="form-actions"><button class="button button-dark" type="submit">Guardar palavra-passe</button></div></form>`);
  }
  openRegistration = () => authForm('register-participant');
  function openLogin() { authForm('login'); }
  openDashboard = async () => {
    if (!account) { openLogin(); return; }
    try {
      await loadOrders();
      const own = customEvents.filter(item => item.organizer === account.id);
      const mine = orders.filter(item => account.rawRole === 'admin' || item.email === account.email);
      let content = `<div class="account-summary"><div class="avatar">${esc(account.name.split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase())}</div><div><strong>${esc(account.name)}</strong><small>${esc(account.email)} · ${esc(account.role)}</small></div></div>`;
      if (account.rawRole === 'organizer' || account.rawRole === 'admin') content += `<h3 class="report-heading">Os seus eventos</h3>${own.length ? `<div class="dashboard-list">${own.map(item=>`<div class="dashboard-item"><strong>${esc(item.title)}</strong><span>${money(item.price)} · ${esc(item.place)}</span></div>`).join('')}</div>` : '<p class="form-note">Ainda não publicou eventos.</p>'}<button class="button button-dark" data-action="publish">Criar evento</button>`;
      if (mine.length) content += `<h3 class="report-heading">Os seus pedidos e ingressos</h3><div class="dashboard-list">${mine.map(item=>{
        const methodLabel=paymentMethodLabel(item.paymentMethod);
        if(item.status==='paid'){
          return `<button type="button" class="receipt-card paid" data-download-pdf="${esc(item.id)}"><strong>${esc(item.eventTitle)}</strong><span>${item.quantity} ingresso(s) · ${esc(item.reference)}</span><span>Ingresso digital: ${esc(item.digitalTicketCode||item.reference)}</span><span class="receipt-status">✓ Pago — clicar para baixar PDF</span></button>`;
        }
        return `<button type="button" class="receipt-card pending" data-download-pdf="${esc(item.id)}"><strong>${esc(item.eventTitle)}</strong><span>${item.quantity} ingresso(s) · ${esc(item.reference)}</span><span>${esc(methodLabel)}</span><span class="receipt-status">● Comprovativo pendente — clicar para baixar PDF</span></button>`;
      }).join('')}</div>`;
      content += `<div class="form-actions"><button class="button button-outline" data-action="logout">Sair da conta</button></div>`;
      openModal('A sua conta', 'Dados e atividade guardados na plataforma.', content);
    } catch (error) { showError(error.message); }
  };
  async function organizerPanel() {
    if (!account) { openLogin(); return; }
    try {
      const rows = await request('/rest/v1/rpc/get_my_organizer_event_report', { method:'POST', body:'{}' });
      const events = rows || [];
      const sold = events.reduce((sum,row)=>sum+Number(row.tickets_sold||0),0);
      const reserved = events.reduce((sum,row)=>sum+Number(row.tickets_reserved||0),0);
      const gross = events.reduce((sum,row)=>sum+Number(row.confirmed_gross||0),0);
      const reportRows = events.length ? events.map(row=>`<tr><td><strong>${esc(row.title)}</strong><small style="display:block;color:#68766d;margin-top:4px">${row.starts_at?formatDate(row.starts_at):'Data por definir'}</small></td><td>${row.tickets_sold}</td><td>${row.tickets_reserved}</td><td>${currency(row.confirmed_gross)}</td></tr>`).join('') : '<tr><td colspan="4">Ainda não publicou eventos.</td></tr>';
      openModal('Painel do organizador','Vendas e reservas apenas dos seus eventos.',`<div class="account-summary"><div class="avatar">${esc(account.name.split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase())}</div><div><strong>${esc(account.name)}</strong><small>${esc(account.email)} · Organizador</small></div></div><div class="report-summary"><div class="metric"><small>Os meus eventos</small><strong>${events.length}</strong></div><div class="metric"><small>Ingressos pagos</small><strong>${sold}</strong></div><div class="metric"><small>Ingressos reservados</small><strong>${reserved}</strong></div><div class="metric"><small>Faturamento confirmado</small><strong>${currency(gross)}</strong></div></div><p class="form-note">O relatório apresenta totais. Os dados pessoais dos compradores não aparecem neste painel.</p><h3 class="report-heading">Relatório por evento</h3><div class="report-table-wrap"><table class="report-table"><thead><tr><th>Evento</th><th>Ingressos pagos</th><th>Reservas</th><th>Faturamento confirmado</th></tr></thead><tbody>${reportRows}</tbody></table></div><div class="form-actions"><button class="button button-outline" data-action="publish">Publicar evento</button><button class="button button-outline" data-action="logout">Sair da conta</button></div>`);
    } catch (error) { showError(error.message, 'Painel do organizador'); }
  }
  publishEvent = () => {
    if (!account) { authIntent = 'publish'; openLogin(); return; }
    if (account.rawRole === 'organizer' && account.organizerStatus === 'pending') {
      openModal('Cadastro em análise', 'O seu perfil de organizador aguarda aprovação da administração.', '<p class="form-note">Pode preparar os dados, mas não conseguirá publicar atividades até que um administrador aprove o cadastro.</p><div class="form-actions"><button class="button button-dark" data-close>Entendi</button></div>');
      return;
    }
    if (account.rawRole === 'organizer' && account.organizerStatus === 'suspended') {
      openModal('Cadastro suspenso', 'A sua conta de organizador está suspensa.', '<p class="form-note">Contacte a administração da NEXUS para solicitar a reativação.</p><div class="form-actions"><button class="button button-dark" data-close>Entendi</button></div>');
      return;
    }
    pendingEventImages = [];
    pendingEventVideos = [];
    const organizerFields = account.rawRole !== 'admin' ? `${account.profileHasName ? '' : `<div class="field"><label for="organizerName">Nome do organizador</label><input id="organizerName" name="organizer_name" required maxlength="80" placeholder="O nome que aparecerá no anúncio"></div>`}<div class="field"><label for="organizerContactPhone">Telefone de contacto</label><input id="organizerContactPhone" name="contact_phone" type="tel" value="${esc(account.phone)}" required maxlength="30"></div>
      ${account.identitySubmitted ? '<p class="form-note full">Dados de identificação recebidos e reservados à administração.</p>' : '<div class="field"><label for="organizerBi">Número do BI</label><input id="organizerBi" name="bi_number" required maxlength="32" autocomplete="off"></div>'}
      <div class="field full"><label for="organizerPhoto">Foto de perfil do organizador</label><input id="organizerPhoto" name="organizer_photo" type="file" accept="image/jpeg,image/png,image/webp" ${account.profilePhotoPath ? '' : 'required'}><span class="help">Esta foto e o telefone aparecem no anúncio. O BI fica reservado à administração.</span>${account.profilePhotoUrl ? `<img src="${esc(account.profilePhotoUrl)}" alt="Foto atual do organizador" style="width:84px;height:84px;object-fit:cover;border-radius:50%;margin-top:8px">` : ''}</div>` : '';
    openModal('Publicar um evento', 'Preencha os dados do evento e as informações do organizador.', `<form data-form="event"><div class="form-grid">
      ${organizerFields}
      <div class="field full"><label for="eventTitle">Nome do evento</label><input id="eventTitle" name="title" required maxlength="90"></div>
      <div class="field"><label for="eventCategory">Categoria</label><select id="eventCategory" name="category"><option>Casamentos</option><option>Festas</option><option>Música</option><option>Cultura</option><option>Lifestyle</option></select></div>
      <div class="field"><label for="eventDate">Data e hora</label><input id="eventDate" name="date" type="datetime-local" required></div>
      <div class="field full"><label for="eventPlace">Local</label><input id="eventPlace" name="place" required maxlength="100"></div>
      <div class="field"><label for="eventPrice">Preço por ingresso (Kz)</label><input id="eventPrice" name="price" type="number" min="0" step="500" value="5000" required></div>
      <div class="field"><label for="eventQuantity">Quantidade</label><input id="eventQuantity" name="quantity" type="number" min="1" max="100000" value="100" required></div>
      <div class="field full"><label for="eventImage">Flyers e fotografias (até 5)</label><input id="eventImage" name="images" type="file" multiple accept="image/jpeg,image/png,image/webp"><span class="help">JPG, PNG ou WEBP, até 10 MB por imagem.</span><div class="upload-gallery" id="eventImagePreview"></div><span class="help" id="uploadMessage" aria-live="polite"></span></div>
      <div class="field full"><label for="eventVideo">Vídeos do evento (até 2)</label><input id="eventVideo" name="videos" type="file" multiple accept="video/mp4,video/webm,video/quicktime"><span class="help">MP4, WEBM ou MOV, até 100 MB por vídeo.</span><div class="upload-gallery" id="eventVideoPreview"></div><span class="help" id="videoUploadMessage" aria-live="polite"></span></div>
      <div class="field full"><label for="eventDescription">Descrição</label><textarea id="eventDescription" name="description" maxlength="500"></textarea></div></div>
      <p class="form-note">As reservas são registadas como pendentes. Pagamentos online ainda não estão integrados.</p><div class="form-actions"><button type="button" class="button button-outline" data-close>Cancelar</button><button class="button button-dark" type="submit">Publicar evento</button></div></form>`);
    const videoInput = modalBody.querySelector('#eventVideo');
    videoInput?.addEventListener('change', () => {
      const allowed = ['video/mp4','video/webm','video/quicktime'];
      const selected = Array.from(videoInput.files || []).slice(0, 2);
      pendingEventVideos = [];
      for (const file of selected) {
        if (!allowed.includes(file.type)) {
          const message = modalBody.querySelector('#videoUploadMessage');
          if (message) message.textContent = 'Formato inválido. Use MP4, WEBM ou MOV.';
          videoInput.value = '';
          return;
        }
        if (file.size > 100 * 1024 * 1024) {
          const message = modalBody.querySelector('#videoUploadMessage');
          if (message) message.textContent = 'O vídeo deve ter até 100 MB.';
          videoInput.value = '';
          return;
        }
        pendingEventVideos.push({ file, name: file.name, type: file.type, label: 'Vídeo do evento' });
      }
      const preview = modalBody.querySelector('#eventVideoPreview');
      if (preview) preview.innerHTML = pendingEventVideos.map((video,index)=>`<div class="upload-thumb"><video controls preload="metadata" style="width:100%;height:95px;object-fit:cover"><source src="${esc(URL.createObjectURL(video.file))}" type="${esc(video.type)}"></video><button type="button" data-remove-video="${index}">Remover</button></div>`).join('');
      const message = modalBody.querySelector('#videoUploadMessage');
      if (message) message.textContent = pendingEventVideos.length ? `${pendingEventVideos.length} vídeo(s) pronto(s) para publicar.` : '';
    });
  };
  async function uploadEventVideos(eventId, videos) {
    let position = 0;
    for (const video of videos) {
      const objectPath = `${account.id}/${eventId}/${crypto.randomUUID()}-${video.name}`;
      await request(`/storage/v1/object/event-media/${objectPath.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST',
        headers: { 'Content-Type': video.type, 'x-upsert': 'false' },
        body: video.file
      });
      await request('/rest/v1/event_media', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          event_id: eventId,
          object_path: objectPath,
          media_type: 'video',
          label: video.label || 'Vídeo do evento',
          position
        })
      });
      position++;
    }
  }
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
  async function saveOrganizerDetails(data) {
    if (account.rawRole === 'admin') return { name: account.name, phone: account.phone, photoUrl: account.profilePhotoUrl || '' };
    const name = (data.organizer_name || account.name || '').trim();
    if (!name) throw new Error('Introduza o nome do organizador que aparecerá no anúncio.');
    const phone = (data.contact_phone || '').trim();
    if (!phone) throw new Error('Introduza o telefone de contacto que aparecerá no anúncio.');
    const photo = data.organizer_photo;
    let path = account.profilePhotoPath || '';
    if (photo instanceof File && photo.size) {
      if (!['image/jpeg','image/png','image/webp'].includes(photo.type) || photo.size > 5 * 1024 * 1024) {
        throw new Error('A foto de perfil deve ser JPG, PNG ou WEBP e ter até 5 MB.');
      }
      const ext = photo.type === 'image/jpeg' ? 'jpg' : photo.type.split('/')[1];
      path = `${account.id}/${crypto.randomUUID()}.${ext}`;
      await request(`/storage/v1/object/organizer-profile-photos/${path.split('/').map(encodeURIComponent).join('/')}`, {
        method:'POST', headers:{'Content-Type':photo.type,'x-upsert':'false'}, body:photo
      });
    }
    if (!path) throw new Error('Adicione a foto de perfil do organizador.');
    if (!account.identitySubmitted) {
      if (!(data.bi_number || '').trim()) throw new Error('Introduza o número do BI para validar o organizador.');
      await request('/rest/v1/rpc/save_organizer_bi',{method:'POST',body:JSON.stringify({p_bi_number:data.bi_number.trim()})});
    }
    await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(account.id)}`,{
      method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({full_name:name,phone,profile_photo_path:path})
    });
    account.name=name;account.profileHasName=true;account.phone=phone;account.profilePhotoPath=path;account.profilePhotoUrl=publicProfilePhoto(path);
    const label=document.querySelector('#accountButton span');if(label)label.textContent=name;
    account.identitySubmitted=Boolean(await request('/rest/v1/rpc/has_organizer_bi',{method:'POST',body:'{}'}));
    return {name,phone,photoUrl:account.profilePhotoUrl};
  }
  async function saveEvent(data, eventId = null) {
    const old = eventId ? allEvents().find(item=>item.id===eventId) : null;
    const organizer = await saveOrganizerDetails(data);
    const payload = { title:data.title.trim(), category:data.category, starts_at:new Date(data.date).toISOString(), venue:data.place.trim(),
      description:(data.description||'').trim(), ticket_price:Number(data.price), ticket_capacity:Number(data.quantity),
      status:old ? old.status : (account.rawRole==='admin'?'published':'draft'),
      organizer_name:old?old.organizerName||'':organizer.name, organizer_phone:old?old.organizerPhone||'':organizer.phone,
      organizer_photo_url:old?old.organizerPhotoUrl||'':organizer.photoUrl };
    let rows;
    if (old) rows = await request(`/rest/v1/events?id=eq.${encodeURIComponent(eventId)}`, { method:'PATCH', headers:{Prefer:'return=representation'}, body:JSON.stringify(payload) });
    else rows = await request('/rest/v1/events', { method:'POST', headers:{Prefer:'return=representation'}, body:JSON.stringify({...payload,organizer_id:account.id}) });
    const saved = rows?.[0];
    if (!saved) throw new Error('O evento não foi guardado. Confirme se a sua conta tem acesso de organizador.');
    await uploadImages(saved.id, pendingEventImages);
    await uploadEventVideos(saved.id, pendingEventVideos);
    pendingEventImages = [];
    pendingEventVideos = [];
    await loadEvents(); modal.close(); document.getElementById('eventos').scrollIntoView({behavior:'smooth'});
    showConfirmation(
      old?'Evento atualizado':account.rawRole==='admin'?'Evento publicado':'Evento enviado',
      old?'As alterações foram guardadas':account.rawRole==='admin'?'O evento já está na plataforma':'O evento aguarda aprovação da administração',
      `EV-${saved.id.slice(0,6).toUpperCase()}`
    );
  }
  openCheckoutForm = event => {
    selectedEvent = event;
    const remaining = Math.max(0, Number.isFinite(event.remaining) ? event.remaining : event.quantity);
    if (remaining < 1) {
      openModal('Ingressos esgotados', event.title, '<p class="form-note">Todos os lugares deste evento já foram reservados ou vendidos.</p><div class="form-actions"><button class="button button-dark" data-close>Entendi</button></div>');
      return;
    }
    const maximum = Math.min(20, remaining);
    openModal('Comprar ingresso', `${event.title} · ${event.place}`, `<form data-form="checkout"><div class="form-grid">
      <div class="field full"><label>E-mail do participante</label><input value="${esc(account?.email||'')}" disabled></div>
      <div class="field"><label for="ticketQty">Quantidade</label><select id="ticketQty" name="quantity">${Array.from({length: maximum}, (_, index) => index + 1).map(n=>`<option>${n}</option>`).join('')}</select></div>
      <div class="field"><label>Total estimado</label><input id="orderTotal" value="${money(event.price*1)}" disabled></div>
      <div class="field full"><label for="paymentMethod">Método de pagamento</label><select id="paymentMethod" name="paymentMethod" required>
        <option value="multicaixa_express">Multicaixa Express</option>
        <option value="referencia">Pagamento por referência</option>
        <option value="transferencia">Transferência bancária</option>
        <option value="cartao">Cartão bancário</option>
        <option value="dinheiro">Dinheiro / pagamento no local</option>
      </select></div>
      <div class="field full"><label for="paymentProof">Referência ou comprovativo</label><input id="paymentProof" name="paymentProof" maxlength="80" placeholder="Opcional agora; acrescentar após pagar"></div></div>
      <p class="form-note" id="paymentInstructions">Pague com Multicaixa Express e informe a referência obtida no pagamento. O ingresso digital só será liberado após confirmação administrativa.</p>
      <div class="form-actions"><button type="button" class="button button-outline" data-close>Cancelar</button><button class="button button-dark" type="submit">Criar pedido de compra</button></div></form>`);
    modalBody.querySelector('#ticketQty').addEventListener('change',e=>{modalBody.querySelector('#orderTotal').value=money(event.price*Number(e.target.value));});
    const instructions = {
      multicaixa_express:'Pague com Multicaixa Express e informe a referência obtida no pagamento. O ingresso digital só será liberado após confirmação administrativa.',
      referencia:'O pagamento por referência ficará pendente até a referência ser confirmada pela administração.',
      transferencia:'Faça a transferência para os dados fornecidos pela NEXUS e guarde o comprovativo. O ingresso é liberado após confirmação.',
      cartao:'O pagamento por cartão depende de um gateway ligado ao projeto. Até lá, o pedido ficará pendente para confirmação administrativa.',
      dinheiro:'Leve o comprovativo de compra e pague no local, se o organizador permitir. Só o pagamento confirmado gera o ingresso digital.'
    };
    modalBody.querySelector('#paymentMethod').addEventListener('change', e => {
      modalBody.querySelector('#paymentInstructions').textContent = instructions[e.target.value];
    });
  };
  checkout = event => { selectedEvent = event; if (!account) { authIntent = 'checkout'; openLogin(); return; } openCheckoutForm(event); };
  function paymentMethodLabel(method) {
    return {
      multicaixa_express:'Multicaixa Express',
      referencia:'Pagamento por referência',
      transferencia:'Transferência bancária',
      cartao:'Cartão bancário',
      dinheiro:'Dinheiro / local'
    }[method] || 'Método por confirmar';
  }
  function downloadOrderPdf(orderId) {
    const order = orders.find(item => item.id === orderId);
    if (!order) return;
    const paid = order.status === 'paid';
    const title = paid ? 'COMPROVATIVO DE PAGAMENTO E INGRESSO DIGITAL' : 'COMPROVATIVO DE COMPRA - PAGAMENTO PENDENTE';
    const color = paid ? '#2d8a57' : '#d84b43';
    const status = paid ? 'PAGO' : 'PENDENTE';
    const ticketCode = paid ? (order.digitalTicketCode || order.reference) : 'O código será emitido após confirmação';
    const pdfWindow = window.open('', '_blank');
    if (!pdfWindow) {
      showError('Permita pop-ups para baixar o comprovativo em PDF.');
      return;
    }
    pdfWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(order.reference)}</title><style>
      body{font-family:Arial,sans-serif;margin:40px;color:#192522}.sheet{max-width:720px;margin:auto;border:3px solid ${color};border-radius:14px;padding:28px}.header{border-bottom:1px solid #dfe5df;padding-bottom:18px}.header h1{font-size:22px;margin:0 0 8px}.status{display:inline-block;background:${color};color:white;padding:8px 12px;border-radius:7px;font-weight:bold}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:22px 0}.box{border:1px solid #dde5df;border-radius:8px;padding:14px}.box small{display:block;color:#687570;margin-bottom:5px}.code{text-align:center;font-size:24px;font-weight:bold;border:2px dashed ${color};border-radius:8px;padding:18px;margin:20px 0}.footer{font-size:11px;color:#687570;text-align:center;margin-top:24px}@media print{body{margin:0}.sheet{max-width:none;margin:0;border-width:3px}}
    </style></head><body><div class="sheet"><div class="header"><h1>NEXUS EVENTOS</h1><div class="status">${status}</div></div><h2>${esc(title)}</h2><div class="grid"><div class="box"><small>Evento</small><strong>${esc(order.eventTitle)}</strong></div><div class="box"><small>Participante</small><strong>${esc(order.name||account?.name||'Participante')}</strong></div><div class="box"><small>Quantidade</small><strong>${order.quantity} ingresso(s)</strong></div><div class="box"><small>Total</small><strong>${currency(order.total)}</strong></div><div class="box"><small>Referência da compra</small><strong>${esc(order.reference)}</strong></div><div class="box"><small>Método</small><strong>${esc(paymentMethodLabel(order.paymentMethod))}</strong></div></div>${order.paymentReference?`<div class="box"><small>Referência ou comprovativo informado</small><strong>${esc(order.paymentReference)}</strong></div>`:''}<div class="code">${esc(ticketCode)}</div><div class="footer">${paid?'Apresente este comprovativo impresso ou no telemóvel na entrada.':'Não apresenta ingresso digital enquanto o pagamento estiver pendente.'}<br>Emitido pela plataforma NEXUS EVENTOS.</div></div><script>window.onload=()=>{window.print()};<\\/script></body></html>`);
    pdfWindow.document.close();
  }
  function showPaidTicket(orderId) {
    const order = orders.find(item => item.id === orderId);
    if (!order || order.status !== 'paid') {
      openModal('Ingresso bloqueado','O ingresso só fica disponível após confirmação do pagamento.','<p class="form-note">Guarde a referência da compra e aguarde a validação administrativa.</p><div class="form-actions"><button class="button button-dark" data-close>Entendi</button></div>');
      return;
    }
    const ticketCode = order.digitalTicketCode || order.reference;
    openModal('Ingresso digital',order.eventTitle,`<div class="success-box" id="printableTicket"><svg class="icon"><use href="#i-ticket"/></svg><h3>${esc(order.eventTitle)}</h3><p><strong>${esc(order.name)}</strong><br>${esc(order.quantity)} ingresso(s)</p><span class="ticket-reference">${esc(ticketCode)}</span><p style="margin-top:12px">Apresente este código impresso ou no telemóvel na entrada.</p></div><p class="form-note"><strong>Comprovativo:</strong> ${esc(order.reference)} · ${esc(paymentMethodLabel(order.paymentMethod))}<br>${order.paymentReference ? `Referência de pagamento: ${esc(order.paymentReference)}<br>` : ''}Pago em ${order.paidAt ? esc(formatDate(order.paidAt)) : 'data confirmada pela administração'}.</p><div class="form-actions"><button class="button button-outline" data-close>Fechar</button><button class="button button-dark" data-print-ticket="printableTicket">Imprimir / guardar PDF</button></div>`);
  }
  showConfirmation = (title,message,reference) => openModal(title,'',`<div class="success-box"><svg class="icon"><use href="#i-ticket"/></svg><h3>${esc(message)}</h3><p>Guarde esta referência para consultar a reserva.</p><span class="ticket-reference">${esc(reference)}</span></div><div class="form-actions"><button class="button button-dark" data-close>Concluir</button></div>`);
  async function adminPanel() {
    if (account?.rawRole !== 'admin') { openLogin(); return; }
    try {
      const [reports, settings, profiles, identityData, moderationEvents] = await Promise.all([
        request('/rest/v1/admin_event_report?select=*&order=starts_at.desc'),
        request('/rest/v1/platform_settings?key=eq.commission_percent&select=value'),
        request('/rest/v1/profiles?select=id,full_name,phone,role&order=created_at.asc'),
        request('/rest/v1/organizer_private_data?select=user_id,bi_number'),
        request('/rest/v1/events?select=id,title,status,organizer_id,starts_at&order=created_at.desc')
      ]);
      const profileById=new Map((profiles||[]).map(profile=>[profile.id,profile]));
      const biByOrganizer=new Map((identityData||[]).map(row=>[row.user_id,row.bi_number]));
      commissionRate = Number(settings?.[0]?.value ?? 10);
      await loadOrders();
      const sold = reports.reduce((sum,row)=>sum+Number(row.tickets_sold||0),0), reserved=reports.reduce((sum,row)=>sum+Number(row.tickets_reserved||0),0);
      const gross=reports.reduce((sum,row)=>sum+Number(row.confirmed_gross||0),0), nexus=gross*commissionRate/100;
      const organizers=(profiles||[]).filter(profile=>profile.role==='organizer');
      const organizerRows=organizers.length?organizers.map(profile=>{
        const status=profile.organizer_status||'pending';
        const bi=biByOrganizer.get(profile.id)||'—';
        return `<tr><td><strong>${esc(profile.full_name||'Sem nome')}</strong><small style="display:block;margin-top:4px">${esc(profile.phone||'Sem telefone')}</small></td><td>${esc(status)}</td><td>${esc(bi)}</td><td><div class="admin-actions">${status==='pending'?`<button data-approve-organizer="${esc(profile.id)}">Aprovar</button>`:''}${status==='approved'?`<button class="danger" data-suspend-organizer="${esc(profile.id)}">Suspender</button>`:''}${status==='suspended'?`<button data-approve-organizer="${esc(profile.id)}">Reativar</button>`:''}</div></td></tr>`;
      }).join(''):'<tr><td colspan="4">Ainda não há organizadores cadastrados.</td></tr>';
      const eventQueue=(moderationEvents||[]).filter(row=>row.status==='draft');
      const queueRows=eventQueue.length?eventQueue.map(row=>{
        const organizer=profileById.get(row.organizer_id);
        return `<tr><td><strong>${esc(row.title)}</strong></td><td>${esc(organizer?.full_name||'Organizador')}</td><td>${row.starts_at?esc(formatDate(row.starts_at)):'Sem data'}</td><td><div class="admin-actions"><button data-review-event="${esc(row.id)}" data-event-review-status="published">Publicar</button><button class="danger" data-review-event="${esc(row.id)}" data-event-review-status="cancelled">Rejeitar</button></div></td></tr>`;
      }).join(''):'<tr><td colspan="4">Não há atividades aguardando aprovação.</td></tr>';
      const rows=reports.length?reports.map(row=>`<tr><td><strong>${esc(row.title)}</strong></td><td>${row.tickets_sold}</td><td>${row.tickets_reserved}</td><td>${currency(row.confirmed_gross)}</td><td>${currency(row.reserved_gross)}</td><td>${currency(Number(row.confirmed_gross)*commissionRate/100)}</td><td>${currency(Number(row.reserved_gross)*commissionRate/100)}</td><td>${currency(Number(row.confirmed_gross)*(1-commissionRate/100))}</td><td>${esc(profileById.get(row.organizer_id)?.full_name||'—')}</td><td>${esc(biByOrganizer.get(row.organizer_id)||'—')}</td><td><div class="admin-actions"><button data-edit-event="${esc(row.event_id)}">Editar</button><button class="danger" data-delete-event="${esc(row.event_id)}">Cancelar</button></div></td></tr>`).join(''):'<tr><td colspan="10">Ainda não há eventos para gerir.</td></tr>';
      const recent=orders.slice(0,30).map(order=>`<div class="dashboard-item"><div><strong>${esc(order.eventTitle)}</strong><span style="display:block;margin-top:4px">${esc(order.email)} · ${order.quantity} ingresso(s) · ${esc(order.reference)}</span></div>${order.status==='paid'?'<strong>Pago</strong>':order.status==='reserved'?`<button class="button button-dark" data-mark-paid="${esc(order.reference)}">Confirmar pagamento</button>`:esc(order.status)}</div>`).join('')||'<p class="form-note">Ainda não há reservas.</p>';
      openModal('Painel de administração','Controlo central de contas, atividades, vendas e pagamentos.',`<div class="report-summary"><div class="metric"><small>Eventos</small><strong>${reports.length}</strong></div><div class="metric"><small>Ingressos pagos</small><strong>${sold}</strong></div><div class="metric"><small>Ingressos reservados</small><strong>${reserved}</strong></div><div class="metric"><small>Faturamento confirmado</small><strong>${currency(gross)}</strong></div><div class="metric"><small>Receita NEXUS</small><strong>${currency(nexus)}</strong></div></div><p class="report-note">Reservas não são pagamentos. Só marque uma reserva como paga após confirmar o recebimento. Pagamentos online ainda não estão integrados.</p><div class="commission-control"><div class="field"><label for="commissionRate">Comissão NEXUS (%)</label><input id="commissionRate" type="number" min="0" max="100" step="0.5" value="${commissionRate}"></div><button class="button button-dark" data-action="save-commission">Guardar comissão</button><button class="button button-outline" data-action="export-report">Baixar relatório CSV</button><button class="button button-outline" data-action="admin-new">Novo evento</button><button class="button button-outline" data-action="admin-logout">Sair</button></div><h3 class="report-heading">Cadastros de organizadores</h3><div class="report-table-wrap"><table class="report-table"><thead><tr><th>Organizador</th><th>Estado</th><th>BI</th><th>Decisão</th></tr></thead><tbody>${organizerRows}</tbody></table></div><h3 class="report-heading">Atividades aguardando aprovação</h3><div class="report-table-wrap"><table class="report-table"><thead><tr><th>Atividade</th><th>Organizador</th><th>Data</th><th>Decisão</th></tr></thead><tbody>${queueRows}</tbody></table></div><h3 class="report-heading">Relatório por evento</h3><div class="report-table-wrap"><table class="report-table"><thead><tr><th>Evento</th><th>Pagos</th><th>Reservas</th><th>Faturamento</th><th>Valor reservado</th><th>NEXUS recebido</th><th>NEXUS estimado</th><th>Organizador</th><th>BI do organizador</th><th>Gerir</th></tr></thead><tbody>${rows}</tbody></table></div><h3 class="report-heading">Reservas recentes</h3><div class="reservation-list">${recent}</div>`);
    } catch (error) { showError(error.message, 'Painel administrativo'); }
  }
  window.adminPanel = adminPanel;
  window.adminAccess = () => { if(account?.rawRole==='admin')adminPanel();else if(account)organizerPanel();else{authIntent='admin';openLogin();} };
  confirmOrderPayment = reference => {
    if (account?.rawRole !== 'admin') return;
    const order=orders.find(item=>item.reference===reference); if(!order)return;
    openModal('Confirmar pagamento','Confirme apenas depois de verificar o recebimento.',`<p class="form-note">Marcar como pago: <strong>${esc(order.eventTitle)}</strong>, ${order.quantity} ingresso(s), total ${currency(order.total)}.<br>Método: ${esc(paymentMethodLabel(order.paymentMethod))}${order.paymentReference?` · Referência: ${esc(order.paymentReference)}`:''}</p><div class="form-actions"><button class="button button-outline" data-close>Cancelar</button><button class="button button-dark" data-confirm-paid="${esc(reference)}">Confirmar recebimento</button></div>`);
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
  async function showEventDetails(eventId) {
    const event = allEvents().find(item => item.id === eventId);
    if (!event) return;
    const social=await loadEventSocial(eventId);
    const organizer = event.organizerName || event.organizerPhone || event.organizerPhotoUrl ? `<div class="event-organizer">${event.organizerPhotoUrl ? `<img src="${esc(event.organizerPhotoUrl)}" alt="${esc(event.organizerName||'Organizador')}">` : ''}<div><strong>${esc(event.organizerName||'Organizador')}</strong><small>Organizador do evento</small>${event.organizerPhone ? `<a href="tel:${esc(event.organizerPhone.replace(/[^\d+]/g,''))}">${esc(event.organizerPhone)}</a>` : ''}</div></div>` : '';
    const media = (event.images || []).map(item => item.type === 'video'
      ? `<div class="detail-photo"><video controls preload="metadata" style="width:100%;height:200px;object-fit:cover"><source src="${esc(item.src)}"></video><span>${esc(item.label||'Vídeo do evento')}</span></div>`
      : `<button type="button" class="detail-photo" data-full-image="${esc(item.src)}"><img src="${esc(item.src)}" alt="${esc(item.label||'Imagem do evento')}"><span>${esc(item.label||'Imagem do evento')}</span></button>`).join('');
    const comments=social.comments.length ? social.comments.map(comment=>`<div class="dashboard-item"><div><strong>${esc(comment.author_name||'Participante')}</strong><span style="display:block;margin-top:4px">${esc(comment.content)}</span><small style="display:block;margin-top:5px;color:#687570">${esc(formatDate(comment.created_at))}</small></div></div>`).join('') : '<p class="form-note">Ainda não há comentários. Seja o primeiro a comentar.</p>';
    openModal('Detalhes do evento', `${event.category} · ${event.date} · ${event.place}`, `<p style="font-size:14px;line-height:1.65;color:#53615b">${esc(event.description||'Veja os detalhes, imagens e vídeos deste evento.')}</p>${organizer}${media ? `<div class="detail-gallery">${media}</div>` : '<p class="form-note">Ainda não há imagens ou vídeos neste evento.</p>'}<div class="event-bottom"><div><span class="price-label">Ingresso a partir de</span><span class="price">${money(event.price)}</span></div><button class="button button-dark" data-buy="${esc(event.id)}">Ver ingressos</button></div><h3 class="report-heading">Gostos e comentários</h3><div class="form-actions" style="justify-content:flex-start;margin-top:8px"><button class="button ${social.liked?'button-dark':'button-outline'}" data-toggle-event-like="${esc(eventId)}">${social.liked?'♥ Gosto':'♡ Gostar'} · ${social.likeCount}</button></div><form data-form="event-comment" data-event-id="${esc(eventId)}"><div class="field full"><label for="eventComment">Deixe um comentário</label><textarea id="eventComment" name="comment" maxlength="500" required placeholder="Partilhe a sua opinião sobre este evento"></textarea></div><div class="form-actions"><button class="button button-dark" type="submit">Publicar comentário</button></div></form><div class="dashboard-list" style="margin-top:12px">${comments}</div>`);
  }
  window.renderEvents = renderEvents;
  document.addEventListener('click', async event => {
    const actionTarget=event.target.closest('[data-action]'), action=actionTarget?.dataset.action;
    const removeVideo=event.target.closest('[data-remove-video]');
    if(removeVideo){
      event.preventDefault();event.stopImmediatePropagation();
      const index=Number(removeVideo.dataset.removeVideo);
      pendingEventVideos.splice(index,1);
      const preview=modalBody.querySelector('#eventVideoPreview');
      if(preview)preview.innerHTML=pendingEventVideos.map((video,videoIndex)=>`<div class="upload-thumb"><video controls preload="metadata" style="width:100%;height:95px;object-fit:cover"><source src="${esc(URL.createObjectURL(video.file))}" type="${esc(video.type)}"></video><button type="button" data-remove-video="${videoIndex}">Remover</button></div>`).join('');
      const input=modalBody.querySelector('#eventVideo');if(input)input.value='';
      const message=modalBody.querySelector('#videoUploadMessage');if(message)message.textContent=pendingEventVideos.length?`${pendingEventVideos.length} vídeo(s) pronto(s).`:'Nenhum vídeo selecionado.';
      return;
    }
    const auth=event.target.closest('[data-auth]')?.dataset.auth;
    if(auth){event.preventDefault();event.stopImmediatePropagation();authForm(auth);return;}
    if(event.target.closest('[data-action="account"]')){event.preventDefault();event.stopImmediatePropagation();if(!account)openLogin();return;}
    if(event.target.closest('[data-action="publish"]')||['admin-new'].includes(action)){event.preventDefault();event.stopImmediatePropagation();publishEvent();return;}
    if(action==='admin-logout'||action==='logout'){event.preventDefault();event.stopImmediatePropagation();try{await request('/auth/v1/logout',{method:'POST'});}catch{}saveSession(null);account=null;accountId=null;adminSession=false;orders=[];authIntent=null;document.querySelector('#accountButton span').textContent='Entrar';document.getElementById('logoutButton').style.display='none';modal.close();return;}
    if(action==='logout-register'){event.preventDefault();event.stopImmediatePropagation();saveSession(null);account=null;accountId=null;authIntent=null;modal.close();openLogin();return;}
    if(action==='save-commission'){event.preventDefault();event.stopImmediatePropagation();const rate=Number(modalBody.querySelector('#commissionRate')?.value);if(!Number.isFinite(rate)||rate<0||rate>100)return;try{await request('/rest/v1/platform_settings?key=eq.commission_percent',{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({value:rate})});await adminPanel();}catch(error){showError(error.message);}return;}
    if(action==='export-report'){event.preventDefault();event.stopImmediatePropagation();downloadReport();return;}
    const cancelReservation=event.target.closest('[data-cancel-reservation]');
    if(cancelReservation){
      event.preventDefault();event.stopImmediatePropagation();
      const orderId=cancelReservation.dataset.cancelReservation;
      openModal('Cancelar reserva','Libera os lugares reservados para outra pessoa.',`<p class="form-note">Tem certeza de que deseja cancelar esta reserva?</p><div class="form-actions"><button class="button button-outline" data-close>Manter reserva</button><button class="button button-dark" data-confirm-cancel-reservation="${esc(orderId)}">Cancelar reserva</button></div>`);
      return;
    }
    const confirmCancelReservation=event.target.closest('[data-confirm-cancel-reservation]');
    if(confirmCancelReservation){
      event.preventDefault();event.stopImmediatePropagation();
      try{
        await request('/rest/v1/rpc/cancel_my_reservation',{method:'POST',body:JSON.stringify({p_order_id:confirmCancelReservation.dataset.confirmCancelReservation})});
        modal.close();await loadEvents();await loadOrders();showConfirmation('Reserva cancelada','Os lugares foram liberados','');
      }catch(error){showError(error.message,'Cancelar reserva');}
      return;
    }
    const edit=event.target.closest('[data-edit-event]');if(edit){event.preventDefault();event.stopImmediatePropagation();editManagedEvent(edit.dataset.editEvent);return;}
    const cancel=event.target.closest('[data-delete-event]');if(cancel){event.preventDefault();event.stopImmediatePropagation();confirmDeleteEvent(cancel.dataset.deleteEvent);return;}
    const approve=event.target.closest('[data-approve-organizer]');
    if(approve){event.preventDefault();event.stopImmediatePropagation();try{await request('/rest/v1/rpc/approve_organizer',{method:'POST',body:JSON.stringify({p_user_id:approve.dataset.approveOrganizer})});await adminPanel();}catch(error){showError(error.message,'Aprovar organizador');}return;}
    const suspend=event.target.closest('[data-suspend-organizer]');
    if(suspend){event.preventDefault();event.stopImmediatePropagation();try{await request('/rest/v1/rpc/suspend_organizer',{method:'POST',body:JSON.stringify({p_user_id:suspend.dataset.suspendOrganizer})});await adminPanel();}catch(error){showError(error.message,'Suspender organizador');}return;}
    const review=event.target.closest('[data-review-event]');
    if(review){event.preventDefault();event.stopImmediatePropagation();const status=review.dataset.eventReviewStatus;try{await request('/rest/v1/rpc/review_event',{method:'POST',body:JSON.stringify({p_event_id:review.dataset.reviewEvent,p_status:status})});await loadEvents();await adminPanel();}catch(error){showError(error.message,'Revisão da atividade');}return;}
    const confirmed=event.target.closest('[data-confirm-delete]');if(confirmed){event.preventDefault();event.stopImmediatePropagation();try{await request(`/rest/v1/events?id=eq.${encodeURIComponent(confirmed.dataset.confirmDelete)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'cancelled'})});modal.close();await loadEvents();await adminPanel();}catch(error){showError(error.message);}return;}
    const mark=event.target.closest('[data-mark-paid]');if(mark){event.preventDefault();event.stopImmediatePropagation();confirmOrderPayment(mark.dataset.markPaid);return;}
    const showTicket=event.target.closest('[data-show-ticket]');
    if(showTicket){event.preventDefault();event.stopImmediatePropagation();showPaidTicket(showTicket.dataset.showTicket);return;}
    const downloadPdf=event.target.closest('[data-download-pdf]');
    if(downloadPdf){event.preventDefault();event.stopImmediatePropagation();downloadOrderPdf(downloadPdf.dataset.downloadPdf);return;}
    const toggleLike=event.target.closest('[data-toggle-event-like]');
    if(toggleLike){
      event.preventDefault();event.stopImmediatePropagation();
      try{
        await toggleEventLike(toggleLike.dataset.toggleEventLike);
        await showEventDetails(toggleLike.dataset.toggleEventLike);
      }catch(error){showError(error.message,'Gostar do evento')}
      return;
    }
    const printTicket=event.target.closest('[data-print-ticket]');
    if(printTicket){event.preventDefault();event.stopImmediatePropagation();window.print();return;}
    const printReceipt=event.target.closest('[data-print-receipt]');
    if(printReceipt){event.preventDefault();event.stopImmediatePropagation();window.print();return;}
    const paid=event.target.closest('[data-confirm-paid]');
    if(paid){
      event.preventDefault();event.stopImmediatePropagation();
      const order=orders.find(row=>row.reference===paid.dataset.confirmPaid);if(!order)return;
      try{
        await request('/rest/v1/rpc/issue_paid_ticket',{method:'POST',body:JSON.stringify({p_order_id:order.id})});
        modal.close();await loadOrders();await adminPanel();
      }catch(error){showError(error.message,'Confirmar pagamento');}
      return;
    }
    const view=event.target.closest('[data-view-event]');if(view){event.preventDefault();event.stopImmediatePropagation();showEventDetails(view.dataset.viewEvent);return;}
    const buy=event.target.closest('[data-buy]');if(buy){event.preventDefault();event.stopImmediatePropagation();const item=allEvents().find(row=>row.id===buy.dataset.buy);if(item)checkout(item);return;}
  }, true);
  document.addEventListener('submit', async event => {
    const form=event.target.closest('form[data-form]');if(!form)return;
    const kind=form.dataset.form;if(!['register','login','password-recovery-request','password-update','event','edit-event','checkout','event-comment'].includes(kind))return;
    event.preventDefault();event.stopImmediatePropagation();const data=Object.fromEntries(new FormData(form));
    try{
      if(kind==='register'){
        const email=data.email.trim().toLowerCase();
        const result=await request('/auth/v1/signup',{method:'POST',body:JSON.stringify({email,password:data.password,data:{full_name:data.name.trim(),phone:data.phone.trim(),role:data.role}})},false);
        if(result.access_token){saveSession(result);await loadAccount();await loadEvents();modal.close();if(authIntent==='publish')publishEvent();else if(authIntent==='checkout'&&selectedEvent)openCheckoutForm(selectedEvent);authIntent=null;}
        else openModal('Confirmação ainda ativa','A conta foi criada, mas o Supabase ainda exige confirmação por e-mail.',`<p class="form-note">Para entrar diretamente após o cadastro, o administrador precisa desativar “Confirm email” nas definições de autenticação do projeto Supabase.</p><div class="form-actions"><button class="button button-dark" data-close>Entendi</button></div>`);
      } else if(kind==='login'){
        const result=await request('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email:data.email.trim().toLowerCase(),password:data.password})},false);
        saveSession(result);await loadAccount();await loadEvents();modal.close();if(authIntent==='publish')publishEvent();else if(authIntent==='checkout'&&selectedEvent)openCheckoutForm(selectedEvent);else if(authIntent==='admin'){if(account?.rawRole==='admin')adminPanel();else organizerPanel();}authIntent=null;
      } else if(kind==='password-recovery-request'){
        await request('/auth/v1/recover',{method:'POST',body:JSON.stringify({email:data.email.trim().toLowerCase()})},false);
        openModal('Verifique o seu e-mail','Enviámos um link para criar uma nova palavra-passe.',`<p class="form-note">Abra o link neste dispositivo e escolha a nova palavra-passe.</p><div class="form-actions"><button class="button button-dark" data-close>Concluir</button></div>`);
      } else if(kind==='password-update'){
        await request('/auth/v1/user',{method:'PUT',body:JSON.stringify({password:data.password})});
        await loadAccount();openModal('Palavra-passe atualizada','A sua conta já pode ser usada normalmente.',`<div class="form-actions"><button class="button button-dark" data-close>Concluir</button></div>`);
      } else if(kind==='event'||kind==='edit-event'){
        const id=kind==='edit-event'?form.dataset.eventId:null;await saveEvent(data,id);
      } else if(kind==='event-comment'){
        if(!account){authIntent='social';openLogin();return;}
        await submitEventComment(form.dataset.eventId, data.comment);
        await showEventDetails(form.dataset.eventId);
      } else if(kind==='checkout'){
        if(!account||!selectedEvent)throw new Error('Entre na sua conta antes de reservar.');
        const quantity=Number(data.quantity||1);
        const result=await request('/rest/v1/ticket_orders',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({
          event_id:selectedEvent.id,buyer_id:account.id,buyer_email:account.email,buyer_name:account.name,
          quantity,unit_price:selectedEvent.price,payment_method:data.paymentMethod,payment_reference:(data.paymentProof||'').trim()||null
        })});
        const order=result?.[0];if(!order)throw new Error('A reserva não foi criada.');
        const method=paymentMethodLabel(data.paymentMethod);
        orders=[{id:order.id,reference:order.reference,eventId:selectedEvent.id,eventTitle:selectedEvent.title,email:account.email,name:account.name,quantity,total:Number(order.total),status:order.status,paymentMethod:data.paymentMethod,paymentReference:(data.paymentProof||'').trim()},...orders];
        modal.close();
        openModal('Pedido de compra registado','Guarde este comprovativo até confirmar o pagamento.',`<div class="success-box"><svg class="icon"><use href="#i-ticket"/></svg><h3>Pedido ${esc(order.reference)}</h3><p>${esc(selectedEvent.title)}<br>${quantity} ingresso(s) · ${currency(order.total)}</p></div><p class="form-note"><strong>Método:</strong> ${esc(method)}<br><strong>Estado:</strong> Aguardando confirmação de pagamento<br><strong>Ingresso digital:</strong> será liberado somente após o pagamento ser confirmado.</p><div class="form-actions"><button class="button button-outline" data-close>Fechar</button><button class="button button-dark" data-print-receipt="true">Imprimir comprovativo</button></div>`);
      }
    }catch(error){showError(error.message);}
  }, true);
  async function initialize(){
    try{const callbackType=await restoreAuthCallback();if(session){await loadAccount();}await loadEvents();if(account)await loadOrders();if(callbackType==='recovery')openPasswordResetForm();}
    catch(error){console.error('NEXUS/Supabase:',error);showError(error.message,'Ligação à plataforma');}
  }
  initialize();
})();

