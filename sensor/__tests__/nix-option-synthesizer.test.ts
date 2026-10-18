/**
 * Nix module-system option wiring (nix-option-path synthesizer).
 *
 * An option is DECLARED in one module (`options.launchd.user.agents =
 * mkOption { ... }`) and SET in others (`launchd.user.agents.yabai = { ... }`)
 * — the module-system evaluator unifies them by option path, so there is no
 * static edge to follow. The synthesizer links each config write to the
 * declaration whose path is the longest plain-segment prefix of the write
 * path, and these tests pin its precision gates: ambiguous declarations bail,
 * dynamic path heads never match, 1-segment paths never register (a package's
 * `meta = { ... }` must not link to `options.meta`), and submodule-internal
 * `options` blocks are quarantined.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LatticeSensor } from '../src';

describe('nix-option-path synthesizer', () => {
  function optionCase(name: string, prepare: (dir: string) => void, check: (edges: any[]) => void) {
    describe(name, () => {
      type Fixture = { dir: string; cg?: LatticeSensor; operation?: Promise<void>; edges?: any[] };
      let fixture: Fixture | undefined;

      beforeEach(async () => {
        const current: Fixture = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nix-option-')) };
        fixture = current;
        // Retain the whole setup chain: a hook timeout does not cancel indexing.
        current.operation = Promise.resolve().then(() => {
          prepare(current.dir);
          return LatticeSensor.init(current.dir, { silent: true });
        }).then(async (cg) => {
          current.cg = cg;
          await cg.indexAll();
          current.edges = synthEdges(cg);
        });
        await current.operation;
      });

      afterEach(async () => {
        const current = fixture;
        fixture = undefined;
        if (!current) return;
        // Capture ownership before waiting; a late hook only cleans its own fixture.
        try {
          await current.operation;
        } finally {
          current.cg?.close();
          fs.rmSync(current.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
      });

      it('preserves the synthesized option edges', () => {
        const edges = fixture?.edges;
        if (!edges) throw new Error('Nix option fixture was not initialized');
        check(edges);
      });
    });
  }

  function synthEdges(cg: LatticeSensor): any[] {
    const db = (cg as any).db.db;
    return db
      .prepare(
        `SELECT s.name source, s.file_path sf, t.name target, t.file_path tf,
                json_extract(e.metadata,'$.optionPath') optionPath
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'nix-option-path'`
      )
      .all();
  }

  optionCase('links a cross-file config write to its flat option declaration', (dir) => {
    fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'modules', 'launchd.nix'),
      `{ config, lib, ... }:
{
  options.launchd.user.agents = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule {});
    default = {};
    description = "launchd agents";
  };
}
`
    );
    fs.writeFileSync(
      path.join(dir, 'modules', 'yabai.nix'),
      `{ config, lib, ... }:
{
  config = lib.mkIf config.services.yabai.enable {
    launchd.user.agents.yabai = {
      command = "yabai";
      keepAlive = true;
    };
  };
}
`
    );
  }, (edges) => {
    const hit = edges.find((e) => e.source === 'launchd.user.agents.yabai');
    expect(hit).toBeDefined();
    expect(hit.target).toBe('options.launchd.user.agents');
    expect(hit.tf).toBe('modules/launchd.nix');
    expect(hit.optionPath).toBe('launchd.user.agents');
  });

  optionCase('composes nested declaration spellings and prefers the longest declared prefix', (dir) => {
    fs.writeFileSync(
      path.join(dir, 'git-module.nix'),
      `{ lib, ... }:
{
  options = {
    programs.git = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
      };
      signing.key = lib.mkOption {
        type = lib.types.str;
        default = "";
      };
    };
  };
}
`
    );
    fs.writeFileSync(
      path.join(dir, 'user-config.nix'),
      `{ ... }:
{
  programs.git.enable = true;
  programs.git.signing.key = "ABCD1234";
}
`
    );
  }, (edges) => {
    const enable = edges.find((e) => e.source === 'programs.git.enable');
    const key = edges.find((e) => e.source === 'programs.git.signing.key');
    expect(enable).toBeDefined();
    // Longest declared prefix wins: the leaf `enable` declaration, not `programs.git`.
    expect(enable.optionPath).toBe('programs.git.enable');
    expect(enable.target).toBe('enable');
    expect(key).toBeDefined();
    expect(key.optionPath).toBe('programs.git.signing.key');
    expect(key.target).toBe('signing.key');
  });

  optionCase('matches through a quoted segment only up to the static prefix', (dir) => {
    fs.writeFileSync(
      path.join(dir, 'xdg.nix'),
      `{ lib, ... }:
{
  options.xdg.configFile = lib.mkOption {
    type = lib.types.attrsOf (lib.types.anything);
    default = {};
  };
}
`
    );
    fs.writeFileSync(
      path.join(dir, 'writer.nix'),
      `{ ... }:
{
  xdg.configFile."git/config".text = "[user]";
}
`
    );
  }, (edges) => {
    const hit = edges.find((e) => e.sf === 'writer.nix');
    expect(hit).toBeDefined();
    expect(hit.optionPath).toBe('xdg.configFile');
    expect(hit.target).toBe('options.xdg.configFile');
  });

  optionCase('anchors quoted writes to their own quoted declaration, never a sibling', (dir) => {
    // NSGlobalDomain-style enumerated quoted options: each quoted write must
    // hit ITS declaration; an undeclared quoted write must not fall back to a
    // same-prefix sibling.
    fs.writeFileSync(
      path.join(dir, 'domain.nix'),
      `{ lib, ... }:
{
  options = {
    system.defaults.NSGlobalDomain."com.apple.keyboard.fnState" = lib.mkOption {
      type = lib.types.nullOr lib.types.bool;
      default = null;
    };
    system.defaults.NSGlobalDomain."com.apple.mouse.tapBehavior" = lib.mkOption {
      type = lib.types.nullOr lib.types.int;
      default = null;
    };
  };
}
`
    );
    fs.writeFileSync(
      path.join(dir, 'writer.nix'),
      `{ ... }:
{
  system.defaults.NSGlobalDomain."com.apple.mouse.tapBehavior" = 1;
  system.defaults.NSGlobalDomain."com.apple.undeclared.domain" = 2;
}
`
    );
  }, (edges) => {
    const tap = edges.filter((e) => e.sf === 'writer.nix' && e.source.includes('tapBehavior'));
    expect(tap).toHaveLength(1);
    expect(tap[0].target).toContain('tapBehavior');
    expect(tap[0].optionPath).toBe('system.defaults.NSGlobalDomain."com.apple.mouse.tapBehavior"');
    // No parent declaration exists, so the undeclared quoted write stays silent.
    expect(edges.filter((e) => e.source.includes('undeclared'))).toEqual([]);
  });

  optionCase('bails on ambiguous declarations and dynamic path heads; never registers 1-segment paths', (dir) => {
    fs.writeFileSync(
      path.join(dir, 'dup-a.nix'),
      `{ lib, ... }: { options.services.dup = lib.mkOption { default = {}; }; }
`
    );
    fs.writeFileSync(
      path.join(dir, 'dup-b.nix'),
      `{ lib, ... }:
{
  options.services.dup = lib.mkOption {
    default = {};
  };
}
`
    );
    fs.writeFileSync(
      path.join(dir, 'meta-decl.nix'),
      `{ lib, ... }:
{
  options.meta = lib.mkOption {
    default = {};
  };
}
`
    );
    fs.writeFileSync(
      path.join(dir, 'writers.nix'),
      `{ name, ... }:
{
  services.dup.enable = true;
  services.\${name}.enable = true;
  meta.maintainers = [ "someone" ];
}
`
    );
  }, (edges) => {
    // services.dup is declared in two files → ambiguous → no edge at all.
    expect(edges.filter((e) => e.source === 'services.dup.enable')).toEqual([]);
    // The interpolated head leaves <2 static segments → no edge.
    expect(edges.filter((e) => e.sf === 'writers.nix' && e.optionPath?.startsWith('services'))).toEqual([]);
    // `options.meta` is a 1-segment path → never registered, `meta.*` writes stay unlinked.
    expect(edges.filter((e) => e.source?.startsWith('meta.'))).toEqual([]);
  });

  optionCase('quarantines submodule-internal options blocks', (dir) => {
    fs.writeFileSync(
      path.join(dir, 'agents.nix'),
      `{ lib, ... }:
{
  options.launchd.agents = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule {
      options = {
        command.text = lib.mkOption {
          type = lib.types.str;
          default = "";
        };
      };
    });
  };
}
`
    );
    fs.writeFileSync(
      path.join(dir, 'writer.nix'),
      `{ ... }:
{
  command.text = "not an option write";
  launchd.agents.myapp = { };
}
`
    );
  }, (edges) => {
    // The submodule's own `command.text` namespace is not globally addressable.
    expect(edges.filter((e) => e.source === 'command.text')).toEqual([]);
    // The outer attrsOf declaration still anchors writes into the attr set.
    const hit = edges.find((e) => e.source === 'launchd.agents.myapp');
    expect(hit).toBeDefined();
    expect(hit.optionPath).toBe('launchd.agents');
  });
});
