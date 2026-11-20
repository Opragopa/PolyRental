/* Every image input keeps its normal picker and its existing change pipeline. */
(() => {
  const entries = new Map(), maxSize = 8 * 1024 * 1024;
  function clear(entry) { if (entry.url) URL.revokeObjectURL(entry.url); entry.url = ''; if (entry.preview) { entry.preview.remove(); entry.preview = null; } }
  function error(entry, message) { entry.status.textContent = message; entry.status.classList.add('error'); }
  function valid(file) {
    if (!file || !file.size) return 'Файл пуст. Выберите другое фото.';
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) return 'Нужно фото JPEG, PNG или WebP.';
    if (file.size > maxSize) return 'Фото должно быть не больше 8 МБ.';
    return '';
  }
  function discover() {
    for (const [input,entry] of entries) if (!input.isConnected) { clear(entry); entries.delete(input); }
    document.querySelectorAll('input[type="file"]').forEach(input => {
      if (entries.has(input) || !/image\//.test(input.accept)) return;
      const zone = input.closest('.field') || input.parentElement;
      zone.classList.add('file-drop-zone');
      const hint = document.createElement('small'); hint.className='drop-hint'; hint.textContent='Перетащите одно фото сюда или выберите файл';
      const status = document.createElement('small'); status.className='drop-status'; status.setAttribute('role','status');
      zone.append(hint,status); const entry={zone,status,url:'',preview:null}; entries.set(input,entry);
      zone.addEventListener('dragover',event=>{if(!event.dataTransfer?.types.includes('Files'))return;event.preventDefault();if(!input.disabled&&!zone.closest('[inert]')){zone.classList.add('drag-over');event.dataTransfer.dropEffect='copy';}});
      zone.addEventListener('dragleave',event=>{if(!zone.contains(event.relatedTarget))zone.classList.remove('drag-over');});
      zone.addEventListener('drop',event=>{
        if(!event.dataTransfer?.types.includes('Files'))return;event.preventDefault();event.stopPropagation();zone.classList.remove('drag-over');
        if(input.disabled||zone.closest('[inert]')||input.closest('form[aria-busy="true"]'))return;
        const files=[...event.dataTransfer.files];if(files.length!==1){error(entry,'Перетащите только одно фото в эту область.');return;}
        const problem=valid(files[0]);if(problem){error(entry,problem);return;}
        try {const transfer=new DataTransfer();transfer.items.add(files[0]);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}
        catch(_){error(entry,'Перетаскивание недоступно в этом браузере. Выберите файл кнопкой.');}
      });
    });
  }
  document.addEventListener('change',event=>{
    const input=event.target,entry=entries.get(input);if(!entry)return;
    const file=input.files?.[0];clear(entry);entry.status.classList.remove('error');entry.status.textContent='';
    if(!file)return;const problem=valid(file);if(problem){input.value='';error(entry,problem);event.stopImmediatePropagation();return;}
    entry.status.textContent=`Выбрано: ${file.name}`;
    if(!input.closest('.dialog-card')?.querySelector('.catalog-upload-preview')){
      entry.url=URL.createObjectURL(file);entry.preview=document.createElement('img');entry.preview.className='drop-preview';entry.preview.alt='Предпросмотр выбранного фото';entry.preview.src=entry.url;entry.zone.append(entry.preview);
    }
  },true);
  for(const name of ['dragover','drop'])document.addEventListener(name,event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
  new MutationObserver(discover).observe(document.body,{childList:true,subtree:true});discover();
  window.PolyRentalFileDrop={clear(input){const entry=entries.get(input);if(entry){clear(entry);entry.status.textContent='';}}};
  document.addEventListener('reset',event=>{for(const [input,entry]of entries)if(input.form===event.target){clear(entry);entry.status.textContent='';}},true);
  window.addEventListener('pagehide',()=>{for(const entry of entries.values())clear(entry);});
})();
