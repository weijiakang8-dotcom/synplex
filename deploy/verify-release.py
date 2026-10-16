"""Verify an exact production SHA without old curl/netrc quoting behavior."""
import base64
import json
import os
from pathlib import Path
import stat
import sys
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Release verification redirects are forbidden')


def credentials(path, origin, expected_owner=0):
    url = urllib.parse.urlsplit(origin)
    if (url.scheme != 'https' or url.username or url.password or url.path
            or url.query or url.fragment or not url.hostname):
        raise ValueError('An exact HTTPS origin is required')
    p = Path(path)
    info = p.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != expected_owner or info.st_mode & 0o077:
        raise ValueError('Private credential file is not protected')
    if info.st_size > 8192:
        raise ValueError('Credential file exceeds bounds')
    values = {}
    text = p.read_text(encoding='utf-8')
    decoder = json.JSONDecoder()
    position = 0
    import re
    while text[position:].strip():
        token = re.match(r'\s*(machine|login|password)\s+', text[position:])
        if not token or token[1] in values:
            raise ValueError('Credential file layout is invalid')
        position += token.end()
        if text[position:].startswith('"'):
            value, used = decoder.raw_decode(text[position:])
        else:
            word = re.match(r'[^\s]+', text[position:])
            if not word:
                raise ValueError('Credential value is missing')
            value, used = word[0], word.end()
        position += used
        if not isinstance(value, str) or not value or '\n' in value or '\r' in value:
            raise ValueError('Credential file value is invalid')
        values[token[1]] = value
    if set(values) != {'machine', 'login', 'password'} or values['machine'] != url.hostname or ':' in values['login']:
        raise ValueError('Credential origin does not match')
    return values['login'], values['password']


def verify(path, origin, sha, expected_owner=0, opener=None):
    import re
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('A full revision is required')
    user, password = credentials(path, origin, expected_owner)
    authorization = base64.b64encode((user + ':' + password).encode('utf-8')).decode('ascii')
    request = urllib.request.Request(origin + '/health', headers={'Authorization': 'Basic ' + authorization})
    opener = opener or urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=20) as response:
        if response.getcode() != 200:
            raise ValueError('Unexpected health status')
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError('Health response exceeds bounds')
        value = json.loads(raw)
    if value.get('ok') is not True or value.get('buildSha') != sha:
        raise ValueError('Health revision mismatch')
    return {'verified': True, 'buildSha': sha}


if __name__ == '__main__':
    try:
        print(json.dumps(verify(*sys.argv[1:]), ensure_ascii=False))
    except Exception:
        # Do not echo credential content, headers, remote response or exceptions.
        print('Release verification failed; credentials were not displayed.', file=sys.stderr)
        sys.exit(1)
