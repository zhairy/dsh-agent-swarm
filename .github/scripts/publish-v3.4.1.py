"""仅发布已固定来源和摘要的v3.4.1；不移动tag或覆盖正式资产。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.parse
import urllib.request
import urllib.error

TAG = 'v3.4.1'
REPO = 'zhairy/dsh-agent-swarm'

def command(*args, check=True):
    return subprocess.run(args, check=check, text=True, capture_output=True, timeout=180)

def git(*args):
    return command('git', *args).stdout.strip()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def load_plan():
    plan = json.loads(Path('.github/release-v3.4.1.json').read_text())
    if plan['tag'] != TAG or plan['repository'] != REPO or plan['hostVersion'] != '0.2.2-rc.3':
        raise RuntimeError('Release identity mismatch')
    if not re.fullmatch(r'[0-9a-f]{40}', plan['assetCommit']):
        raise RuntimeError('Asset commit must be immutable')
    return plan

def verify_source(plan):
    expected = plan['sourceFiles']
    actual = set(path for path in git('ls-files', '-z').split('\0') if path and not path.startswith('.github/'))
    if actual != set(expected):
        raise RuntimeError('Tag source file set changed after verification')
    for name, digest in expected.items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or path.is_symlink() or sha(path.read_bytes()) != digest:
            raise RuntimeError('Tag source checksum mismatch: ' + name)

def prepare(plan):
    verify_source(plan)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write('asset_commit=' + plan['assetCommit'] + '\n')

def api(path, *args, check=True):
    result = command('gh', 'api', 'repos/' + REPO + '/' + path, *args, check=check)
    return json.loads(result.stdout) if result.returncode == 0 else None

def release_for_tag(commit):
    release = api('releases/tags/' + TAG, check=False)
    if release is not None:
        return release
    # Draft可能不能由tag端点寻址，先按列表/id对账，避免重复创建。
    rows = api('releases?per_page=100')
    exact = [row for row in rows if row['tag_name'] == TAG]
    if exact:
        return exact[0]
    # 草稿可能使用untagged占位符；只接管本次明确标题/目标的唯一草稿。
    candidates = [row for row in rows if row.get('draft') is True and row.get('name') == 'DSH Agent Swarm v3.4.1' and row.get('target_commitish') in ['main', commit]]
    if len(candidates) > 1:
        raise RuntimeError('Ambiguous draft releases; refusing duplicate creation')
    if candidates:
        return candidates[0]
    query = 'query { repository(owner:"zhairy", name:"dsh-agent-swarm") { releases(first:100, orderBy:{field:CREATED_AT,direction:DESC}) { nodes { databaseId name tagName isDraft } } } }'
    response = command('gh', 'api', 'graphql', '-f', 'query=' + query, check=False)
    if response.returncode == 0:
        nodes = json.loads(response.stdout).get('data', {}).get('repository', {}).get('releases', {}).get('nodes', [])
        matching = [row for row in nodes if row.get('isDraft') and row.get('name') == 'DSH Agent Swarm v3.4.1']
        if len(matching) > 1:
            raise RuntimeError('Ambiguous draft IDs; refusing duplicate creation')
        if matching:
            row = api('releases/' + str(int(matching[0]['databaseId'])), check=False)
            if row and row.get('draft') and row.get('target_commitish') in ['main', commit]:
                return row
    return None

def verify_revision(plan, commit):
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise RuntimeError('Release source must be an immutable commit')
    command('git', 'fetch', '--no-tags', '--depth=1', 'origin', commit)
    names = set(path for path in git('ls-tree', '-r', '-z', '--name-only', commit).split('\0') if path and not path.startswith('.github/'))
    if names != set(plan['sourceFiles']):
        raise RuntimeError('Pinned release source file set changed')
    for name, expected in plan['sourceFiles'].items():
        data = subprocess.run(['git', 'show', commit + ':' + name], capture_output=True, check=True, timeout=30).stdout
        if sha(data) != expected:
            raise RuntimeError('Pinned release source checksum mismatch: ' + name)

class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        target = urllib.parse.urlparse(url)
        if target.scheme != 'https' or target.hostname not in ['api.github.com', 'uploads.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github.com']:
            raise RuntimeError('Unexpected asset redirect host')
        redirected = super().redirect_request(request, fp, code, message, headers, url)
        if redirected is not None and target.hostname != urllib.parse.urlparse(request.full_url).hostname:
            redirected.remove_header('Authorization')
        return redirected

def asset_request(url, *, data=None, accept='application/vnd.github+json'):
    target = urllib.parse.urlparse(url)
    if target.scheme != 'https' or target.hostname not in ['api.github.com', 'uploads.github.com'] or target.username or target.password:
        raise RuntimeError('Untrusted asset API URL')
    request = urllib.request.Request(url, data=data, headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': accept, 'Content-Type': 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        return urllib.request.build_opener(ReleaseRedirect()).open(request, timeout=180)
    except urllib.error.URLError as error:
        # 不让临时签名URL或请求头进入公开workflow日志。
        raise RuntimeError('GitHub asset transfer failed; status=' + str(getattr(error, 'code', 'network'))) from None

def publish(plan, assets):
    verify_source(plan)
    if os.environ.get('GITHUB_REPOSITORY') != REPO or os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise RuntimeError('Only the authorized default branch may publish')
    execution_commit = git('rev-parse', 'HEAD')
    if execution_commit != os.environ['GITHUB_SHA']:
        raise RuntimeError('Checkout does not match event SHA')
    commit = plan.get('releaseCommit', execution_commit)
    if commit != execution_commit:
        # 修复自动化不改变已建立的产品tag；两份源码必须具有相同受测文件。
        verify_revision(plan, commit)
    expected = plan['assets']
    files = {path.name: path for path in assets.iterdir()}
    if set(files) != set(expected):
        raise RuntimeError('Unexpected release input file set')
    for name, digest in expected.items():
        path = files[name]
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.+_-]{0,160}', name) or '..' in name or not path.is_file() or path.is_symlink() or sha(path.read_bytes()) != digest:
            raise RuntimeError('Invalid release input: ' + name)
    output = Path('publish-output')
    output.mkdir(exist_ok=True)
    for name, path in files.items():
        shutil.copyfile(path, output / name)
    summary_path = output / 'verification-summary.json'
    summary = json.loads(summary_path.read_text())
    summary.update(gitCommit=commit, publicationCommit=execution_commit, sourceTree=git('rev-parse', commit + '^{tree}'), sourceFilesVerified=True)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    package = 'dsh-agent-swarm-3.4.1.tgz'
    manifest = {'schemaVersion': 1, 'package': 'dsh-agent-swarm', 'version': '3.4.1', 'gitCommit': commit, 'tag': TAG, 'sourceTree': summary['sourceTree'], 'assetSourceCommit': plan['assetCommit'], 'hostVersion': plan['hostVersion'], 'tarball': package, 'tarballSha256': sha((output / package).read_bytes()), 'stableTarball': 'dsh-agent-swarm.tgz', 'build': 'locally built exact package; tracked source hashes verified against release commit', 'assets': {path.name: sha(path.read_bytes()) for path in sorted(output.iterdir()) if path.is_file() and path.name not in ['release-manifest.json', 'SHA256SUMS']}}
    (output / 'release-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    sums = {path.name: sha(path.read_bytes()) for path in sorted(output.iterdir()) if path.is_file() and path.name != 'SHA256SUMS'}
    (output / 'SHA256SUMS').write_text(''.join(digest + '  ' + name + '\n' for name, digest in sums.items()))
    # 先验证/创建精确annotated tag，已发布tag不移动。
    ref = api('git/ref/tags/' + TAG, check=False)
    if ref is None:
        tag = api('git/tags', '-X', 'POST', '-f', 'tag=' + TAG, '-f', 'message=DSH Agent Swarm v3.4.1 verified release', '-f', 'object=' + commit, '-f', 'type=commit')
        api('git/refs', '-X', 'POST', '-f', 'ref=refs/tags/' + TAG, '-f', 'sha=' + tag['sha'])
    else:
        obj = ref['object']
        if obj['type'] != 'tag':
            raise RuntimeError('Existing tag is not annotated; refusing to replace or accept it')
        target = api('git/tags/' + obj['sha'])['object']['sha']
        if target != commit:
            raise RuntimeError('Existing tag targets different source; refusing to move it')
    release = release_for_tag(commit)
    if release is None:
        if plan.get('draftMustExist'):
            raise RuntimeError('Known draft is not visible; refusing duplicate creation')
        release = api('releases', '-X', 'POST', '-f', 'tag_name=' + TAG, '-f', 'target_commitish=' + commit, '-f', 'name=DSH Agent Swarm v3.4.1', '-F', 'draft=true', '-f', 'body=' + (output / 'RELEASE-NOTES.zh-CN.md').read_text())
    release_id = int(release['id'])
    if release['draft']:
        release = api('releases/' + str(release_id), '-X', 'PATCH', '-f', 'tag_name=' + TAG, '-f', 'target_commitish=' + commit)
    existing = {row['name']: row for row in release['assets']}
    if set(existing) - {path.name for path in output.iterdir() if path.is_file()}:
        raise RuntimeError('Draft contains unexpected assets')
    downloads = Path('release-download-verification')
    downloads.mkdir(exist_ok=True)
    for file in sorted(output.iterdir()):
        if not file.is_file():
            continue
        if file.name not in existing:
            if not release['draft']:
                raise RuntimeError('Published release is incomplete; refusing mutation')
            url = 'https://uploads.github.com/repos/' + REPO + '/releases/' + str(release_id) + '/assets?name=' + urllib.parse.quote(file.name, safe='')
            with asset_request(url, data=file.read_bytes()) as response:
                uploaded = json.load(response)
            if uploaded.get('name') != file.name or uploaded.get('size') != file.stat().st_size:
                raise RuntimeError('Uploaded asset metadata mismatch')
            existing[file.name] = uploaded
        asset_id = int(existing[file.name]['id'])
        with asset_request('https://api.github.com/repos/' + REPO + '/releases/assets/' + str(asset_id), accept='application/octet-stream') as response:
            (downloads / file.name).write_bytes(response.read())
        if sha((downloads / file.name).read_bytes()) != sha(file.read_bytes()):
            raise RuntimeError('Uploaded/downloaded bytes mismatch: ' + file.name)
    if release['draft']:
        api('releases/' + str(release_id), '-X', 'PATCH', '-F', 'draft=false', '-f', 'make_latest=true')
    final = api('releases/' + str(release_id))
    if final['draft'] or final['prerelease'] or len(final['assets']) != len(list(output.iterdir())):
        raise RuntimeError('Release readback mismatch')
    result = {'verified': True, 'tag': TAG, 'commit': commit, 'url': final['html_url'], 'assets': len(final['assets'])}
    print(json.dumps(result))
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as report:
        report.write('v3.4.1 published and byte-verified: ' + final['html_url'] + '\n\n')
        report.write('```json\n' + json.dumps(result, indent=2) + '\n```\n')
        report.write('```text\n' + (output / 'SHA256SUMS').read_text() + '\n```\n')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'publish'])
    parser.add_argument('--assets', type=Path)
    args = parser.parse_args()
    plan = load_plan()
    if args.action == 'prepare':
        prepare(plan)
    else:
        if args.assets is None:
            parser.error('publish requires --assets')
        publish(plan, args.assets)
