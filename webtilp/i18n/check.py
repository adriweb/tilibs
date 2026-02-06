import json
import os

# Get the directory where the script is located
script_dir = os.path.dirname(os.path.abspath(__file__))

en_keys = set(json.loads(open(os.path.join(script_dir, '../app.js')).read().split('const I18N_EN = ')[1].split(';\n')[0]).keys())
print(f'English keys: {len(en_keys)}')
for lang in ['fr', 'de', 'es', 'it', 'nl', 'pt', 'sv', 'zh', 'fa', 'ja', 'ar', 'la']:
  lang_keys = set(json.load(open(os.path.join(script_dir, f'{lang}.json'))).keys())
  missing = en_keys - lang_keys
  extra = lang_keys - en_keys
  if missing:
    print(f'{lang}: MISSING {len(missing)}: {missing}')
  if extra:
    print(f'{lang}: EXTRA {len(extra)}: {extra}')
  if not missing and not extra:
    print(f'{lang}: OK (complete match)')
