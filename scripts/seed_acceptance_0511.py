"""Idempotent demo equipment only; customers create their own test bookings."""
import os
from sqlalchemy import select
from app.db import Session, Article, Equipment, EquipmentFeature
from app.rental import save_article, save_equipment
from app.inventory import save_feature
from app.roles import configured_ids, staff_allows


def main():
    if not os.environ.get('DATABASE_URL', '').endswith('/polyrental_acceptance'):
        raise RuntimeError('Разрешено только в отдельной базе polyrental_acceptance')
    actor = next((uid for uid in configured_ids('ADMIN_IDS') if staff_allows(uid, 'admin')), None)
    if actor is None: raise RuntimeError('Нужен администратор тестового бота')
    examples = [
        ('CAM','[ТЕСТ 0.5.11] Камера для проверки особенностей','camera',2,'Корпус\nКрышка\nКабель USB'),
        ('LIGHT','[ТЕСТ 0.5.11] Свет с неполным комплектом','light',1,'Прибор\nБлок питания\nЧехол'),
        ('MIC','[ТЕСТ 0.5.11] Микрофон для частичной выдачи','sound',1,'Микрофон\nКабель'),
    ]
    for suffix,name,category,count,composition in examples:
        sku='TEST-0511-'+suffix
        with Session() as session: existing=session.scalar(select(Article).where(Article.sku==sku))
        article_id=save_article(sku,name,'Только для приёмки 0.5.11. Не реальное оборудование.',0,
            category,'generic',0,article_id=existing.id if existing else None,composition=composition,actor_id=actor)
        with Session.begin() as session: session.get(Article,article_id).is_test=True
        for index in range(count):
            code=f'{sku}-{index+1}'
            with Session() as session: asset=session.scalar(select(Equipment).where(Equipment.inventory_number==code))
            asset_id=save_equipment(code,'','',0,'available',asset.id if asset else None,article_id=article_id,storage_location='Тестовая полка')
            feature='Известная царапина на корпусе; работоспособность сохранена.' if suffix=='CAM' and index==1 else 'Чехол отсутствует. При подготовке отметьте его как невыданный элемент комплекта.' if suffix=='LIGHT' else ''
            if feature:
                with Session() as session: found=session.scalar(select(EquipmentFeature.id).where(EquipmentFeature.equipment_id==asset_id,EquipmentFeature.description==feature,EquipmentFeature.deleted_at.is_(None)))
                if found is None: save_feature(asset_id,feature,actor)
        print(f'{sku}: {count} экземпляра; артикул {article_id}')
    print('Создайте заявку самостоятельно: камера ×2, свет ×1, микрофон ×1. При подготовке отметьте чехол отсутствующим, микрофон — частично невыданным.')


if __name__=='__main__': main()
