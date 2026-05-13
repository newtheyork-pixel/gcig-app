import os
import json
import urllib.request

log = os.environ.get('LOG', '')
key = os.environ.get('ANTHROPIC_API_KEY', '')

if not log.strip():
    result = 'No changes were made to the GCIG website this week.'
else:
    prompt = ('Translate these git commits into a 2-4 sentence plain-English summary '
              'for a non-technical reader. No bullet points.\n\n' + log)
    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages',
        data=json.dumps({
            'model': 'claude-haiku-4-5-20251001',
            'max_tokens': 512,
            'messages': [{'role': 'user', 'content': prompt}]
        }).encode(),
        headers={
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        }
    )
    resp = json.loads(urllib.request.urlopen(req).read())
    result = resp['content'][0]['text']

with open('/tmp/plain.txt', 'w') as f:
    f.write(result)
