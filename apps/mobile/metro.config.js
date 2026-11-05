const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

module.exports = (() => {
  const projectRoot = __dirname;
  const repositoryRoot = path.resolve(projectRoot, '../..');
  // Resolve workspace dependency symlinks up front. In managed workspaces the
  // node_modules entries can point at a shared dependency store; Metro must
  // watch and resolve the real directories, not the link paths.
  const dependencyRoots = [
    path.resolve(projectRoot, 'node_modules'),
    path.resolve(repositoryRoot, 'node_modules'),
  ].map((directory) => fs.realpathSync(directory));

  const config = getDefaultConfig(projectRoot);

  // Watch the shared packages as source so no build step is needed for them.
  config.watchFolders = [repositoryRoot, ...dependencyRoots];

  // Let Metro resolve workspace packages from the repo root.
  config.resolver.nodeModulesPaths = dependencyRoots;
  config.resolver.extraNodeModules = {
    ...config.resolver.extraNodeModules,
    '@drivx/design-tokens': path.resolve(repositoryRoot, 'packages/design-tokens'),
    '@drivx/domain': path.resolve(repositoryRoot, 'packages/domain'),
    '@drivx/firebase-client': path.resolve(repositoryRoot, 'packages/firebase-client'),
    '@drivx/ui': path.resolve(repositoryRoot, 'packages/ui'),
  };
  config.resolver.disableHierarchicalLookup = true;

  return config;
})();
