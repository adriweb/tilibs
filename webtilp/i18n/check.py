import json
import os
import re

# Get the directory where the script is located
script_dir = os.path.dirname(os.path.abspath(__file__))

en_messages = json.loads(open(os.path.join(script_dir, '../app.js')).read().split('const I18N_EN = ')[1].split(';\n')[0])
en_keys = set(en_messages.keys())
print(f'English keys: {len(en_keys)}')
all_ok = True
for lang in ['fr', 'de', 'es', 'it', 'nl', 'pt', 'sv', 'zh', 'fa', 'ja', 'ar', 'la']:
  messages = json.load(open(os.path.join(script_dir, f'{lang}.json')))
  lang_keys = set(messages.keys())
  missing = en_keys - lang_keys
  extra = lang_keys - en_keys
  placeholder_mismatches = []
  for key in en_keys & lang_keys:
    expected = set(re.findall(r'\{[^}]+\}', str(en_messages[key])))
    actual = set(re.findall(r'\{[^}]+\}', str(messages[key])))
    if expected != actual:
      placeholder_mismatches.append((key, expected, actual))
  if missing:
    all_ok = False
    print(f'{lang}: MISSING {len(missing)}: {missing}')
  if extra:
    all_ok = False
    print(f'{lang}: EXTRA {len(extra)}: {extra}')
  if placeholder_mismatches:
    all_ok = False
    print(f'{lang}: PLACEHOLDER MISMATCHES: {placeholder_mismatches}')
  if not missing and not extra and not placeholder_mismatches:
    print(f'{lang}: OK (complete match)')

if not all_ok:
  raise SystemExit(1)
