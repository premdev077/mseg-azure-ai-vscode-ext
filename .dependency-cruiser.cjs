/**
 * Architectural boundaries the compiler cannot express.
 *
 * ESLint catches a bad import where it is written; this catches the shape of
 * the graph — a cycle that forms across four files, or a service that has
 * quietly started reaching upward into a store. Those are design errors, and
 * they are invisible one file at a time.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A cycle means two modules each need the other to be defined first. It is a design error, not a bundler warning.',
      from: {},
      to: { circular: true }
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'A module nothing imports is either dead or a missing wire-up.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$',
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(babel|webpack)\\.config\\.(js|cjs|mjs|ts)$',
          '^src/extension\\.ts$',
          '^webview/src/main\\.tsx$',
          '^webview/src/test/'
        ]
      },
      to: {}
    },
    {
      name: 'webview-not-from-host',
      severity: 'error',
      comment:
        'The extension host must not import webview code: it runs in Node with no DOM, and the webview bundle is built separately.',
      from: { path: '^src/' },
      to: { path: '^webview/' }
    },
    {
      name: 'host-internals-not-from-webview',
      severity: 'error',
      comment:
        'The webview may share the event contract and nothing else. Anything further pulls `vscode` into a browser bundle.',
      from: { path: '^webview/' },
      to: { path: '^src/', pathNot: '^src/events/types\\.ts$' }
    },
    {
      name: 'stores-do-not-import-components',
      severity: 'error',
      comment:
        'Dependencies point downward. A store that imports a component cannot be tested without React.',
      from: { path: '^webview/src/store/' },
      to: { path: '^webview/src/(components|features|app)/' }
    },
    {
      name: 'services-do-not-import-components',
      severity: 'error',
      comment: 'Services own the outside world; they never render.',
      from: { path: '^webview/src/services/' },
      to: { path: '^webview/src/(components|features|app)/' }
    },
    {
      name: 'utils-stay-leaves',
      severity: 'error',
      comment:
        'Utils import nothing but other utils, constants and types — otherwise they are services wearing the wrong name.',
      from: { path: '^webview/src/utils/' },
      to: {
        path: '^webview/src/',
        pathNot: '^webview/src/(utils|constants|types)/'
      }
    },
    {
      name: 'ui-primitives-are-domain-free',
      severity: 'error',
      comment:
        'components/ui knows nothing about agents, tasks or the event stream. That is what makes it reusable.',
      from: { path: '^webview/src/components/ui/' },
      to: { path: '^webview/src/(features|store|services)/' }
    },
    {
      name: 'no-cross-feature-imports',
      severity: 'error',
      comment:
        'Features never import each other. If two need the same thing, promote it to the shared layer.',
      from: { path: '^webview/src/features/([^/]+)/' },
      to: {
        path: '^webview/src/features/([^/]+)/',
        pathNot: '^webview/src/features/$1/'
      }
    },
    {
      name: 'no-dev-dep-in-host',
      severity: 'error',
      comment:
        'The extension host bundle ships as-is; a devDependency reaching it would be missing at runtime.',
      from: { path: '^src/', pathNot: '^src/test/' },
      to: { dependencyTypes: ['npm-dev'], pathNot: 'node_modules/@types/' }
    }
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|out|media|node_modules)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'] },
    reporterOptions: {
      text: { highlightFocused: true }
    }
  }
};
