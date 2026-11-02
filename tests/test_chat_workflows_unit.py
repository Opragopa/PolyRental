import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app import chat_workflows as cw


def test_other_users_booking_is_not_accessible(monkeypatch):
    monkeypatch.setattr(cw, 'get_booking', lambda _: SimpleNamespace(customer_id=99))
    try:
        asyncio.run(cw.owned_booking(1, 42))
        assert False, 'must reject another customer'
    except ValueError:
        pass


def test_stale_accept_is_bound_to_exact_change(monkeypatch):
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'get_booking', lambda _: SimpleNamespace(customer_id=42, id=1))
    from app import booking_changes
    called=[]
    def update(*args):
        called.append(args)
        raise cw.Conflict('Изменение уже обработано')
    monkeypatch.setattr(booking_changes, 'update_request', update)
    query=SimpleNamespace(data='cw:accept:1:7', from_user=SimpleNamespace(id=42), answer=AsyncMock(), message=SimpleNamespace())
    asyncio.run(cw.customer_action(query, SimpleNamespace()))
    assert called[0][5] == 7
    assert query.answer.call_args.kwargs['show_alert']


def test_cancel_rechecks_owner_before_transition(monkeypatch):
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'get_booking', lambda _: SimpleNamespace(customer_id=99))
    transition=AsyncMock(); monkeypatch.setattr(cw, 'transition', transition)
    query=SimpleNamespace(data='cw:cancel:1', from_user=SimpleNamespace(id=42), answer=AsyncMock(), message=SimpleNamespace())
    asyncio.run(cw.customer_action(query, SimpleNamespace()))
    transition.assert_not_called()
    assert query.answer.call_args.kwargs['show_alert']


def test_staff_action_checks_current_role(monkeypatch):
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: False)
    write = AsyncMock(); monkeypatch.setattr(cw, 'transition', write)
    query=SimpleNamespace(data='sw:do:1:issued', from_user=SimpleNamespace(id=200), answer=AsyncMock(), message=SimpleNamespace())
    asyncio.run(cw.staff_action(query, SimpleNamespace()))
    write.assert_not_called()
    assert query.answer.call_args.kwargs['show_alert']


def test_manager_edit_requires_current_role_and_bound_state(monkeypatch):
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda _user, role: role == 'operator')
    state=SimpleNamespace(get_data=AsyncMock(), get_state=AsyncMock())
    query=SimpleNamespace(data='sw:editconfirm:1', from_user=SimpleNamespace(id=200), answer=AsyncMock(), message=SimpleNamespace())
    asyncio.run(cw.staff_action(query, state))
    state.get_data.assert_not_called()
    assert query.answer.call_args.kwargs['show_alert']


def test_manager_line_selection_rejects_duplicate_ids(monkeypatch):
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    state=SimpleNamespace(get_data=AsyncMock(return_value={'proposed':{}}), set_state=AsyncMock(), update_data=AsyncMock())
    message=SimpleNamespace(text='1:2, 1:3', from_user=SimpleNamespace(id=200), answer=AsyncMock())
    asyncio.run(cw.manager_edit_lines(message, state))
    state.update_data.assert_not_called()
    assert 'разных позиций' in message.answer.call_args.args[0]


def test_proposal_rejects_changed_snapshot_before_saving(monkeypatch):
    from contextlib import contextmanager
    from datetime import datetime, timezone
    from app import booking_changes
    booking=SimpleNamespace(id=7, deleted_at=None, status='pending', starts_at=datetime(2026,12,1,tzinfo=timezone.utc), ends_at=datetime(2026,12,2,tzinfo=timezone.utc), lines=[])
    class FakeSession:
        def get(self, *_args, **_kwargs): return booking
        def add(self, *_args): raise AssertionError('must not write stale proposal')
    class FakeSessionFactory:
        @staticmethod
        @contextmanager
        def begin(): yield FakeSession()
    monkeypatch.setattr(booking_changes, 'Session', FakeSessionFactory)
    monkeypatch.setattr(booking_changes, 'require_role', lambda *_: None)
    stale={'start':'2026-11-01T00:00:00+00:00','end':'2026-11-02T00:00:00+00:00','lines':[]}
    try:
        booking_changes.propose_change(7, 200, 'manager_edit', 'Тест', {}, stale)
        assert False, 'must reject changed snapshot'
    except cw.Conflict as exc:
        assert 'изменилась' in str(exc)


def test_assignment_rejects_duplicate_asset(monkeypatch):
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    monkeypatch.setattr(cw, 'get_booking', lambda _: SimpleNamespace(status='preparing', lines=[SimpleNamespace(id=10,quantity=1),SimpleNamespace(id=20,quantity=1)]))
    state=SimpleNamespace(get_data=AsyncMock(return_value={'booking_id':1}),update_data=AsyncMock(),set_state=AsyncMock())
    message=SimpleNamespace(text='10:5;20:5',from_user=SimpleNamespace(id=200),answer=AsyncMock())
    asyncio.run(cw.staff_assignment_choose(message,state))
    state.update_data.assert_not_called()
    assert 'дважды' in message.answer.call_args.args[0]


def test_assignment_confirmation_rechecks_state(monkeypatch):
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    state=SimpleNamespace(get_data=AsyncMock(return_value={'booking_id':2}),get_state=AsyncMock(return_value=cw.StaffAssignment.confirm.state))
    query=SimpleNamespace(data='sw:assignconfirm:1', from_user=SimpleNamespace(id=200), answer=AsyncMock(), message=SimpleNamespace())
    asyncio.run(cw.staff_action(query,state))
    assert query.answer.call_args.kwargs['show_alert']


def test_inspection_pass_preserves_checked_components_and_signature(monkeypatch):
    from app import rental
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    saved=[]; monkeypatch.setattr(rental, 'record_inspection', lambda *args: saved.append(args))
    monkeypatch.setattr(cw, 'inspection_list', AsyncMock())
    data={'booking_id':1,'equipment_id':5,'stage':'pre_issue','nonce':'abcd1234','signature':'expected', 'components':[{'state':'issued'},{'state':'missing'}]}
    state=SimpleNamespace(get_data=AsyncMock(return_value=data),get_state=AsyncMock(return_value=cw.StaffInspection.choose.state),clear=AsyncMock())
    query=SimpleNamespace(data='sw:inspectionpass:1:5:abcd1234',from_user=SimpleNamespace(id=201,full_name='Оператор'),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(cw.staff_action(query,state))
    assert saved[0][3:5] == ('pass', {'component:0':True})
    assert saved[0][-1] == 'expected'
    state.clear.assert_awaited_once()


def test_inspection_rejects_old_button(monkeypatch):
    from app import rental
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    save=AsyncMock(); monkeypatch.setattr(rental, 'record_inspection', save)
    data={'booking_id':1,'equipment_id':5,'nonce':'new'}
    state=SimpleNamespace(get_data=AsyncMock(return_value=data),get_state=AsyncMock(return_value=cw.StaffInspection.choose.state))
    query=SimpleNamespace(data='sw:inspectionpass:1:5:old',from_user=SimpleNamespace(id=202),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(cw.staff_action(query,state))
    save.assert_not_called()
    assert query.answer.call_args.kwargs['show_alert']


def test_inspection_rejects_invalid_cost(monkeypatch):
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    state=SimpleNamespace(update_data=AsyncMock(),set_state=AsyncMock())
    message=SimpleNamespace(text='-500',from_user=SimpleNamespace(id=42),answer=AsyncMock())
    asyncio.run(cw.inspection_cost(message,state))
    state.update_data.assert_not_called()
    assert 'неотрицательную' in message.answer.call_args.args[0]


def test_inspection_service_rejects_changed_components_before_write(monkeypatch):
    from contextlib import contextmanager
    from app import rental, handover, inventory
    monkeypatch.setattr(inventory, 'require_role', lambda *_: None)
    monkeypatch.setattr(rental, '_claim_stage', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(handover, 'asset_components', lambda *_: [{'name':'новая деталь','state':'issued'}])
    class FakeSession:
        def scalar(self, *_args): return SimpleNamespace(status='preparing')
        def get(self, *_args): return SimpleNamespace(deleted_at=None)
        def add(self, *_args): raise AssertionError('stale inspection must not be saved')
    class FakeSessionFactory:
        @staticmethod
        @contextmanager
        def begin(): yield FakeSession()
    monkeypatch.setattr(rental, 'Session', FakeSessionFactory)
    try:
        rental.record_inspection(1, 2, 'pre_issue', 'pass', {'component:0':True}, '', 100, expected_components_signature='old')
        assert False, 'must reject changed composition'
    except rental.Conflict as exc:
        assert 'изменилась' in str(exc)


def test_partial_assignment_parses_missing_faulty_and_replacement():
    booking=SimpleNamespace(lines=[SimpleNamespace(id=10,quantity=3),SimpleNamespace(id=20,quantity=1)])
    assignments, exceptions=cw.parse_assignment('10:5,нет,замена=8;20:неисправен',booking)
    assert assignments == {'10':[5,8], '20':[]}
    assert [(item['line_id'],item['reason']) for item in exceptions] == [(10,'missing'),(10,'replacement'),(20,'faulty')]
    assert exceptions[1]['replacement_id'] == 8


def test_partial_assignment_rejects_duplicate_and_empty_handover():
    import pytest
    booking=SimpleNamespace(lines=[SimpleNamespace(id=10,quantity=2)])
    with pytest.raises(ValueError, match='дважды'): cw.parse_assignment('10:5,замена=5',booking)
    with pytest.raises(ValueError, match='хотя бы один'): cw.parse_assignment('10:нет,неисправен',booking)


def test_component_exception_rejects_unknown_component(monkeypatch):
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    data={'assignment_components':{'5':['Крышка']},'exceptions':[],'assignments':{'10':[5]}}
    state=SimpleNamespace(get_data=AsyncMock(return_value=data),update_data=AsyncMock())
    message=SimpleNamespace(text='5 | Зарядка | нет',from_user=SimpleNamespace(id=42),answer=AsyncMock())
    asyncio.run(cw.staff_assignment_components(message,state))
    state.update_data.assert_not_called()
    assert 'Проверьте' in message.answer.call_args.args[0]


def test_assignment_confirm_rejects_old_nonce(monkeypatch):
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    state=SimpleNamespace(get_data=AsyncMock(return_value={'booking_id':1,'assignment_nonce':'new'}),get_state=AsyncMock(return_value=cw.StaffAssignment.confirm.state))
    query=SimpleNamespace(data='sw:assignconfirm:1:old',from_user=SimpleNamespace(id=239),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(cw.staff_action(query,state))
    assert query.answer.call_args.kwargs['show_alert']


def test_damage_photo_upload_uses_shared_service(monkeypatch):
    from app import miniapp
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    save=AsyncMock(); monkeypatch.setattr(miniapp, 'save_inspection_photo_bytes', save)
    monkeypatch.setattr(cw, 'inspection_list', AsyncMock())
    state=SimpleNamespace(get_state=AsyncMock(return_value=cw.StaffInspection.photo.state),get_data=AsyncMock(return_value={'booking_id':1,'equipment_id':5}),clear=AsyncMock())
    photo=SimpleNamespace(file_size=4)
    user=SimpleNamespace(id=312, first_name='Имя',last_name='',username=None)
    message=SimpleNamespace(photo=[photo],document=None,text=None,from_user=user,answer=AsyncMock())
    async def download(_photo,destination,seek): destination.write(b'test')
    asyncio.run(cw.inspection_photo(message,state,SimpleNamespace(download=download)))
    assert save.await_args.args[:4] == (1,5,b'test','image/jpeg')
    state.clear.assert_awaited_once()


def test_damage_photo_rejects_oversized_stream(monkeypatch):
    from app import miniapp
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    save=AsyncMock(); monkeypatch.setattr(miniapp, 'save_inspection_photo_bytes', save)
    state=SimpleNamespace(get_state=AsyncMock(return_value=cw.StaffInspection.photo.state),get_data=AsyncMock(return_value={'booking_id':1,'equipment_id':5}),clear=AsyncMock())
    message=SimpleNamespace(photo=[SimpleNamespace(file_size=None)],document=None,text=None,from_user=SimpleNamespace(id=313),answer=AsyncMock())
    async def download(_photo,destination,seek): destination.write(b'x'*(8*1024*1024+1))
    asyncio.run(cw.inspection_photo(message,state,SimpleNamespace(download=download)))
    save.assert_not_awaited(); state.clear.assert_not_awaited()
    assert '8 МБ' in message.answer.call_args.args[0]


def test_photo_buffer_enforces_limit_across_chunks():
    import pytest
    buffer=cw.LimitedPhotoBuffer(4)
    buffer.write(b'123'); buffer.flush(); buffer.write(b'4')
    with pytest.raises(ValueError): buffer.write(b'5')
    assert buffer.getvalue()==b'1234'


def test_photo_buffer_works_with_aiogram_stream():
    from aiogram import Bot
    async def stream():
        yield b'ab'
        yield b'cd'
    sink=cw.LimitedPhotoBuffer(4)
    result=asyncio.run(Bot._Bot__download_file_binary_io(destination=sink, seek=False, stream=stream()))
    assert result.getvalue() == b'abcd'


def test_repair_close_rejects_revoked_role(monkeypatch):
    from app import rental
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: False)
    close=AsyncMock(); monkeypatch.setattr(rental, 'close_repair', close)
    query=SimpleNamespace(data='rp:close:42',from_user=SimpleNamespace(id=444),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(cw.repair_action(query))
    close.assert_not_called(); assert query.answer.call_args.kwargs['show_alert']


def test_repair_search_filters_and_paginates(monkeypatch):
    from app import rental
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    equipment=SimpleNamespace(name='Камера',inventory_number='A001')
    tickets=[SimpleNamespace(id=i,equipment=equipment,status='open') for i in range(1,9)]
    monkeypatch.setattr(rental, 'list_repairs', lambda: tickets)
    cw._repair_queries[445]='камера'
    message=SimpleNamespace(answer=AsyncMock())
    asyncio.run(cw.repair_list(message,445))
    keyboard=message.answer.call_args.kwargs['reply_markup'].inline_keyboard
    assert len(keyboard)==7
    assert keyboard[-1][0].callback_data=='rp:page:1'


def test_quiet_hours_invalid_time_and_stale_button(monkeypatch):
    from app import operator_preferences
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    state=SimpleNamespace(update_data=AsyncMock(),set_state=AsyncMock())
    message=SimpleNamespace(text='24:00 08:00',from_user=SimpleNamespace(id=446),answer=AsyncMock())
    asyncio.run(cw.quiet_input(message,state))
    state.update_data.assert_not_awaited()
    save=AsyncMock(); monkeypatch.setattr(operator_preferences, 'save_preferences', save)
    state=SimpleNamespace(get_data=AsyncMock(return_value={'quiet_nonce':'new'}),get_state=AsyncMock(return_value=cw.QuietHours.confirm.state))
    query=SimpleNamespace(data='qh:save:old',from_user=SimpleNamespace(id=446),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(cw.quiet_action(query,state))
    save.assert_not_called(); assert query.answer.call_args.kwargs['show_alert']


def test_support_claim_requires_separate_pii_permission(monkeypatch):
    from app import support, roles
    monkeypatch.setattr(cw, 'private', lambda _: True)
    monkeypatch.setattr(cw, 'staff_allows', lambda *_: True)
    monkeypatch.setattr(roles, 'configured_ids', lambda name: frozenset() if name=='PII_ADMIN_IDS' else frozenset({321}))
    claim=AsyncMock(); monkeypatch.setattr(support, 'claim_thread', claim)
    query=SimpleNamespace(data='sp:claim:4',from_user=SimpleNamespace(id=321),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(cw.staff_support_action(query))
    claim.assert_not_called(); assert query.answer.call_args.kwargs['show_alert']


def test_support_rejects_closed_thread_claim(monkeypatch):
    from contextlib import contextmanager
    from app import support
    class FakeSession:
        def scalar(self,*_): return SimpleNamespace(status='resolved',owner_id=None)
        def add(self,*_): raise AssertionError('closed thread must remain closed')
    class FakeSessionFactory:
        @staticmethod
        @contextmanager
        def begin(): yield FakeSession()
    monkeypatch.setattr(support, 'Session', FakeSessionFactory)
    import pytest
    with pytest.raises(support.SupportConflict, match='закрыто'): support.claim_thread(1,321)


def test_support_link_contains_thread_without_messages(monkeypatch):
    monkeypatch.setenv('PUBLIC_URL','https://example.test')
    link=cw.support_app_button(45)
    assert link.web_app.url=='https://example.test/miniapp?startapp=support_45'


def test_customer_support_list_scopes_query_to_owner(monkeypatch):
    from app import support
    calls=[]
    def list_threads(**kwargs): calls.append(kwargs); return []
    monkeypatch.setattr(support,'list_threads',list_threads)
    message=SimpleNamespace(answer=AsyncMock())
    asyncio.run(cw.customer_support_list(message,777,0))
    assert calls==[{'customer_id':777}]


def test_receipt_pages_keep_all_items_and_hide_notes():
    data={'snapshot':[{'name':'Камера','features':[{'description':'царапина'}], 'components':[{'name':'Кабель','state':'issued'}]}], 'exceptions':[{'name':'Объектив','reason':'missing','note':'скрыто'}]}
    pages=cw.receipt_pages(data,max_chars=50)
    assert len(pages)>1 and all(len(page)<=50 for page in pages)
    text=''.join(pages)
    assert 'Камера' in text and 'Кабель' in text and 'Объектив' in text
    assert 'скрыто' not in text


def test_receipt_confirm_rejects_unread_pages(monkeypatch):
    monkeypatch.setattr(cw,'private',lambda _:True)
    monkeypatch.setattr(cw,'get_booking',lambda _:SimpleNamespace(customer_id=42))
    save=AsyncMock();monkeypatch.setattr(cw,'customer_attest',save)
    data={'receipt_booking':5,'receipt_nonce':'abc','receipt_seen':0,'receipt_pages':['first','second']}
    state=SimpleNamespace(get_data=AsyncMock(return_value=data),get_state=AsyncMock(return_value=cw.CustomerAttestation.reading.state))
    query=SimpleNamespace(data='cw:receiptconfirm:5:abc',from_user=SimpleNamespace(id=42),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(cw.customer_action(query,state))
    save.assert_not_called();assert query.answer.call_args.kwargs['show_alert']


def test_dispute_submission_bound_to_change(monkeypatch):
    from app import booking_changes
    monkeypatch.setattr(cw,'private',lambda _:True)
    monkeypatch.setattr(cw,'get_booking',lambda _:SimpleNamespace(customer_id=42))
    monkeypatch.setattr(cw,'show_customer_booking',AsyncMock())
    saved=[];monkeypatch.setattr(booking_changes,'update_request',lambda *args:saved.append(args))
    data={'dispute_booking':5,'dispute_change':17,'dispute_nonce':'abc','dispute_comment':'Неверные сроки'}
    state=SimpleNamespace(get_data=AsyncMock(return_value=data),get_state=AsyncMock(return_value=cw.CustomerDispute.confirm.state),clear=AsyncMock())
    query=SimpleNamespace(data='cw:disputesave:5:abc',from_user=SimpleNamespace(id=42),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(cw.customer_action(query,state))
    assert saved[0][5:]==(17,False,'Неверные сроки')
    state.clear.assert_awaited_once()


def test_customer_edit_rejects_duplicate_positions(monkeypatch):
    monkeypatch.setattr(cw,'private',lambda _:True)
    monkeypatch.setattr(cw,'owned_booking',AsyncMock(return_value=SimpleNamespace()))
    state=SimpleNamespace(get_data=AsyncMock(return_value={'customer_edit_booking':1}),update_data=AsyncMock(),set_state=AsyncMock())
    message=SimpleNamespace(text='1:2, 1:3',from_user=SimpleNamespace(id=42),answer=AsyncMock())
    asyncio.run(cw.customer_edit_lines(message,state))
    state.update_data.assert_not_awaited();assert 'разных позиций' in message.answer.call_args.args[0]


def test_customer_edit_save_binds_user_and_snapshot(monkeypatch):
    from app import booking_changes
    calls=[];monkeypatch.setattr(booking_changes,'update_request',lambda *args:calls.append(args))
    monkeypatch.setattr(cw,'show_customer_booking',AsyncMock())
    data={'customer_edit_booking':1,'customer_edit_nonce':'n','customer_edit_before':{'lines':[]},'customer_edit_change':7,'customer_edit_proposed':{'start':'2026-12-01T10:00:00+03:00','end':'2026-12-02T10:00:00+03:00','lines':[{'article_id':2,'quantity':1}]}}
    state=SimpleNamespace(get_data=AsyncMock(return_value=data),get_state=AsyncMock(return_value=cw.CustomerEdit.confirm.state),clear=AsyncMock())
    query=SimpleNamespace(from_user=SimpleNamespace(id=42),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(cw.customer_edit_save(query,state,1,'n'))
    assert calls[0][0:2]==(1,42) and calls[0][5]==7 and calls[0][-1]==data['customer_edit_before']
    state.clear.assert_awaited_once()


def test_staff_workflow_rejects_role_downgrade(monkeypatch):
    from app import rental
    monkeypatch.setattr(cw,'staff_allows',lambda _id,role:role=='operator')
    change=AsyncMock();monkeypatch.setattr(rental,'reassign_booking',change)
    state=SimpleNamespace(get_data=AsyncMock(return_value={'workflow_nonce':'ok','workflow_operation':'assignee','workflow_booking':1}),get_state=AsyncMock(return_value=cw.StaffWorkflow.confirm.state))
    query=SimpleNamespace(from_user=SimpleNamespace(id=201,full_name='Оператор'),answer=AsyncMock(),message=SimpleNamespace())
    import pytest
    with pytest.raises(PermissionError):asyncio.run(cw.staff_workflow_save(query,state,'ok'))
    change.assert_not_called()


def test_staff_workflow_prevents_old_confirmation(monkeypatch):
    from app import rental
    monkeypatch.setattr(cw,'staff_allows',lambda *_:True)
    change=AsyncMock();monkeypatch.setattr(rental,'reassign_booking',change)
    state=SimpleNamespace(get_data=AsyncMock(return_value={'workflow_nonce':'new'}),get_state=AsyncMock(return_value=cw.StaffWorkflow.confirm.state))
    query=SimpleNamespace(from_user=SimpleNamespace(id=202),answer=AsyncMock(),message=SimpleNamespace())
    import pytest
    with pytest.raises(cw.Conflict):asyncio.run(cw.staff_workflow_save(query,state,'old'))
    change.assert_not_called()


def test_return_finding_consumes_confirmation_before_append(monkeypatch):
    from app import handover
    monkeypatch.setattr(cw,'staff_allows',lambda *_:True)
    monkeypatch.setattr(cw,'show_staff_booking',AsyncMock())
    events=[]
    def save(*args): events.append(('save',args))
    monkeypatch.setattr(handover,'record_return_finding',save)
    async def clear():events.append(('clear',))
    data={'workflow_nonce':'n','workflow_operation':'finding','workflow_booking':1,'workflow_asset':5,'workflow_kind':'lost','workflow_comment':'Утерян'}
    state=SimpleNamespace(get_data=AsyncMock(return_value=data),get_state=AsyncMock(return_value=cw.StaffWorkflow.confirm.state),clear=AsyncMock(side_effect=clear))
    query=SimpleNamespace(from_user=SimpleNamespace(id=203,full_name='Оператор'),answer=AsyncMock(),message=SimpleNamespace())
    asyncio.run(cw.staff_workflow_save(query,state,'n'))
    assert events[0]==('clear',) and events[1][1]==(1,5,203,'lost','Утерян')
