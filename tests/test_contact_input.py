import pytest

from app.miniapp import validate_contact_value


@pytest.mark.parametrize('value,expected', [
    (' https://t.me/anna_qa ', '@anna_qa'),
    ('t.me/Anna_QA/', '@Anna_QA'),
    ('https://telegram.me/anna_qa', '@anna_qa'),
    ('@anna_qa', '@anna_qa'),
    ('anna_qa', 'anna_qa'),
    ('+7\u00a0(999)\u202f123\u201145\u201467', '+7 (999) 123-45-67'),
])
def test_common_pasted_contact_formats(value, expected):
    assert validate_contact_value(value) == expected


@pytest.mark.parametrize('value', [
    'https://t.me.evil.test/anna_qa', 'https://evil.test/anna_qa',
    'https://t.me/+invitecode', 'https://t.me/anna_qa?text=hello',
    'https://t.me/anna_qa/123', '+7 (999) abc-45-67',
])
def test_ambiguous_and_invalid_contacts_remain_invalid(value):
    with pytest.raises(ValueError):
        validate_contact_value(value)
