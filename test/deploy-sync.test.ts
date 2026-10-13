import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string): string => readFileSync(f, 'utf8');

describe('Windows service, Dockerfile and compose.yaml stay in sync', () => {
  const ps = read('deploy/windows/install-service.ps1');
  const docker = read('Dockerfile');
  const compose = read('compose.yaml');

  it('all three start the same command', () => {
    expect(ps).toMatch(/run --config/);
    expect(docker).toMatch(/"dist\/cli\.js", "run", "--config"/);
    expect(ps).toContain('dist\\cli.js');
  });

  it('use the same relative data/backups/config layout and .env', () => {
    for (const dir of ['data', 'backups']) {
      expect(ps).toContain(`Root '${dir}'`);
      expect(compose).toContain(`/sentinel/${dir}`);
      expect(docker).toContain(`/sentinel/${dir}`);
    }
    expect(compose).toContain('/sentinel/config');
    expect(compose).toContain('env_file: .env');
    expect(ps).toContain('.env');
  });

  it('shipped store paths resolve under the working directory in both', () => {
    const cfg = read('config/sentinel.yaml');
    expect(cfg).toMatch(/path: \.\/data\/sentinel\.db/);
    expect(cfg).toMatch(/backup_dir: \.\/backups/);
  });

  it('never bakes secrets or the wallet file into the image', () => {
    expect(read('.dockerignore')).toMatch(/\.env/);
    expect(read('.dockerignore')).toMatch(/config\/wallets\.yaml/);
    expect(docker).not.toMatch(/COPY\s+(\.\/)?config[/\s]/);
  });

  it('the Windows service rotates logs and restarts on exit', () => {
    for (const needle of ['AppRotateFiles 1', 'AppRotateBytes', 'AppRotateSeconds', 'AppExit Default Restart', 'SERVICE_DELAYED_AUTO_START', 'Register-ScheduledTask']) {
      expect(ps).toContain(needle);
    }
  });
});
