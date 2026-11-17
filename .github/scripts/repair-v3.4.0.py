"""按明确前后摘要修复已授权的 v3.4.0 附件；产品 tag 与主包保持固定。"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import urllib.parse

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-v3.4.0.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
REPO = publisher.REPO
TAG = publisher.TAG
PREFIX = 'overlay-repair-20261117--'
CORE = ['dsh-agent-swarm-3.4.0.tgz', 'dsh-agent-swarm.tgz']


def rest(path, method='GET', **fields):
    args = ['gh', 'api', 'repos/' + REPO + '/' + path, '-X', method]
    for key, value in fields.items():
        args.extend(['-f', key + '=' + str(value)])
    result = publisher.command(*args)
    return json.loads(result.stdout) if result.stdout.strip() else {}


def load_plan():
    plan = json.loads(Path('.github/repair-v3.4.0.json').read_text())
    if (plan['repository'], plan['tag'], plan['releaseId']) != (REPO, TAG, 448013183):
        raise RuntimeError('Repair release identity mismatch')
    for field in ['assetCommit', 'releaseCommit', 'tagObject', 'sourceTree']:
        if not re.fullmatch('[0-9a-f]{40}', plan[field]):
            raise RuntimeError('Repair identity must use immutable SHAs')
    for rows in [plan['beforeAssets'], plan['assets']]:
        for name, digest in rows.items():
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.+_-]{0,160}', name) or '..' in name or not re.fullmatch('[0-9a-f]{64}', digest):
                raise RuntimeError('Invalid repair asset declaration')
    if len(plan['beforeAssets']) != 14 or len(plan['assets']) != 12:
        raise RuntimeError('Unexpected repair asset count')
    for name in CORE:
        if plan['assets'][name] != plan['beforeAssets'][name]:
            raise RuntimeError('Repair cannot change the Swarm binary')
    return plan


def prepare(plan):
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write('asset_commit=' + plan['assetCommit'] + '\n')


def outputs(plan, directory, execution_commit):
    files = {p.name: p.read_bytes() for p in directory.iterdir() if p.is_file() and not p.is_symlink()}
    if len(list(directory.iterdir())) != len(files) or set(files) != set(plan['assets']):
        raise RuntimeError('Repair input file set mismatch')
    if any(publisher.sha(files[n]) != digest for n, digest in plan['assets'].items()):
        raise RuntimeError('Repair input checksum mismatch')
    summary = json.loads(files['verification-summary.json'])
    summary['repairPublicationCommit'] = execution_commit
    summary['repairAssetSourceCommit'] = plan['assetCommit']
    encode = lambda value: (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
    files['verification-summary.json'] = encode(summary)
    manifest = dict(schemaVersion=1, package='dsh-agent-swarm', version='3.4.0', tag=TAG,
                    gitCommit=plan['releaseCommit'], sourceTree=plan['sourceTree'],
                    assetSourceCommit=plan['assetCommit'], hostVersion='0.2.2-rc.3',
                    tarball=CORE[0], stableTarball=CORE[1], tarballSha256=plan['assets'][CORE[0]],
                    build='Original verified Swarm binary; compatibility packaging corrected on 2026-11-17',
                    compatibilityRepair=dict(date='2026-11-17', sourceCommit=execution_commit,
                                             subscriptionsVersion='0.9.13+rc3.transport.2'),
                    assets={n: publisher.sha(b) for n, b in sorted(files.items())})
    files['release-manifest.json'] = encode(manifest)
    files['SHA256SUMS'] = ''.join(publisher.sha(b) + '  ' + n + '\n' for n, b in sorted(files.items())).encode()
    return files


def validate_tag(plan):
    obj = rest('git/ref/tags/' + TAG)['object']
    if obj['type'] != 'tag' or obj['sha'] != plan['tagObject']:
        raise RuntimeError('Product tag changed; refusing repair')
    if rest('git/tags/' + obj['sha'])['object']['sha'] != plan['releaseCommit']:
        raise RuntimeError('Product source changed; refusing repair')


def download(row):
    with publisher.asset_request('https://api.github.com/repos/' + REPO + '/releases/assets/' + str(int(row['id'])), accept='application/octet-stream') as response:
        return response.read()


def validate_state(rows, before, desired):
    """允许同一次修复中断后的已验证暂存件；拒绝接管其它来源的附件。"""
    seen = set()
    for row in rows:
        name = row['name']
        if name in seen:
            raise RuntimeError('Duplicate asset name')
        seen.add(name)
        allowed = {before.get(name), desired.get(name)}
        if name.startswith(PREFIX):
            allowed = {desired.get(name[len(PREFIX):])}
        allowed.discard(None)
        if not allowed or publisher.sha(download(row)) not in allowed:
            raise RuntimeError('Unexpected release asset: ' + name)
    for name in desired:
        if name not in seen and PREFIX + name not in seen and name in before:
            raise RuntimeError('Missing canonical and staged asset: ' + name)


def publish(plan, directory):
    execution = publisher.git('rev-parse', 'HEAD')
    if (os.environ.get('GITHUB_REPOSITORY'), os.environ.get('GITHUB_REF'), os.environ.get('GITHUB_SHA')) != (REPO, 'refs/heads/main', execution):
        raise RuntimeError('Only the checked-out main event may repair')
    files = outputs(plan, directory, execution)
    desired = {n: publisher.sha(b) for n, b in files.items()}
    validate_tag(plan)
    release_path = 'releases/' + str(plan['releaseId'])
    release = rest(release_path)
    if release['tag_name'] != TAG or release['draft'] or release['prerelease']:
        raise RuntimeError('Release state changed')
    validate_state(release['assets'], plan['beforeAssets'], desired)
    existing = {r['name']: r for r in release['assets']}
    staged = {}
    # 所有替代字节先上传并下载核验；此阶段不删除原件。
    for name, data in sorted(files.items()):
        if name in existing and publisher.sha(download(existing[name])) == desired[name]:
            continue
        temporary = PREFIX + name
        row = existing.get(temporary)
        if row is None:
            url = 'https://uploads.github.com/repos/' + REPO + '/' + release_path + '/assets?name=' + urllib.parse.quote(temporary, safe='')
            with publisher.asset_request(url, data=data) as response:
                row = json.load(response)
        if row['name'] != temporary or publisher.sha(download(row)) != desired[name]:
            raise RuntimeError('Staged asset verification failed: ' + name)
        staged[name] = row
    validate_tag(plan)
    # 重新核对前像，避免并发发布期间误删未知资产。
    current = rest(release_path)
    validate_state(current['assets'], plan['beforeAssets'], desired)
    existing = {r['name']: r for r in current['assets']}
    for name, row in staged.items():
        if name in existing:
            rest('releases/assets/' + str(existing[name]['id']), 'DELETE')
        rest('releases/assets/' + str(row['id']), 'PATCH', name=name)
    # 新组件和全部清单就绪后，才移除旧的 transport.1。
    for name in set(plan['beforeAssets']) - set(desired):
        if name in existing:
            rest('releases/assets/' + str(existing[name]['id']), 'DELETE')
    rest(release_path, 'PATCH', body=files['RELEASE-NOTES.zh-CN.md'].decode())
    final = rest(release_path)
    if final['tag_name'] != TAG or final['draft'] or final['prerelease'] or final['body'] != files['RELEASE-NOTES.zh-CN.md'].decode():
        raise RuntimeError('Final release metadata mismatch')
    if len(final['assets']) != len(files) or {r['name'] for r in final['assets']} != set(files):
        raise RuntimeError('Final release asset set mismatch')
    for row in final['assets']:
        if publisher.sha(download(row)) != desired[row['name']]:
            raise RuntimeError('Final asset byte mismatch: ' + row['name'])
    validate_tag(plan)
    result = dict(verified=True, releaseId=plan['releaseId'], url=final['html_url'], assets=desired,
                  productCommit=plan['releaseCommit'], repairCommit=execution)
    print(json.dumps(result))
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
        output.write('v3.4.0 overlay repair: all 14 assets downloaded and byte-verified.\n\n```json\n' + json.dumps(result, indent=2) + '\n```\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'publish'])
    parser.add_argument('--assets', type=Path)
    args = parser.parse_args()
    plan = load_plan()
    if args.action == 'prepare':
        prepare(plan)
    elif args.assets is None:
        parser.error('publish requires --assets')
    else:
        publish(plan, args.assets)
