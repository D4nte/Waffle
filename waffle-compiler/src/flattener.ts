import fs from 'fs';
import path from 'path';
import mkdirp from 'mkdirp';
import {Config, InputConfig, inputToConfig, loadConfig} from './config';
import {ImportsFsEngine, resolvers} from '@resolver-engine/imports-fs';
import {gatherSourcesAndCanonizeImports} from '@resolver-engine/imports';
import {findInputs} from './findInputs';
import {getExtensionForCompilerType, insert} from './utils';

export interface GatheredContractInterface {
  url: string;
  source: string;
  provider: string;
}

export async function flattenProject(configPath?: string) {
  await flattenAndSave(await loadConfig(configPath));
}

export async function flattenAndSave(input: InputConfig) {
  const config = inputToConfig(input);
  const output = await getContractDependency(config);
  await saveToFile(output, config);
}

async function getContractDependency(config: Config): Promise<GatheredContractInterface[][]> {
  const resolver = ImportsFsEngine().addResolver(
    resolvers.BacktrackFsResolver(config.nodeModulesDirectory)
  );

  const allContracts = findInputs(config.sourceDirectory, getExtensionForCompilerType(config));

  return Promise.all(allContracts.map(async contract => gatherSourcesAndCanonizeImports(
    [contract],
    '.',
    resolver
  )));
}

const fsOps = {
  createDirectory: mkdirp.sync,
  writeFile: fs.writeFileSync
};

const unique = <T>(arr: T[]) => [...new Set(arr)];

function saveToFile(
  output: GatheredContractInterface[][],
  config: Config,
  fileSystem = fsOps
) {
  const outputDirectory = config.flattenOutputDirectory;

  fileSystem.createDirectory(outputDirectory);

  output.map((contract: Array<GatheredContractInterface>) => {
    const rootContract = contract[contract.length - 1];
    const fileName = path.parse(rootContract.url).base;
    const filePath = path.join(outputDirectory, fileName);

    const contractsWithCommentedDirectives = contract.map(replaceDirectivesWithComments(rootContract));
    const source = ''.concat(...unique(contractsWithCommentedDirectives));
    const sourceWithNormalizedLicences = normalizeSpdxLicenceIdentifiers(source, fileName);

    fileSystem.writeFile(filePath, sourceWithNormalizedLicences);
  });
}

function replaceDirectivesWithComments(rootContract: GatheredContractInterface) {
  const IMPORT_SOLIDITY_REGEX = /import/gi;
  const IMPORT_NODE_MODULES_REGEX = /(import.*").*node_modules\/(.*\n)/gi;
  const PRAGMA_SOLIDITY_REGEX = /pragma solidity/gi;
  const NODE_MODULES_REGEX = /^.*\/node_modules\//gi;

  return (dependency: GatheredContractInterface) => {
    const sourceWithImportsWithRelativeImports = dependency.source.replace(IMPORT_NODE_MODULES_REGEX, '$1$2');
    const sourceWithCommentedImports = sourceWithImportsWithRelativeImports.replace(IMPORT_SOLIDITY_REGEX, '// import');
    const filePath = dependency.url.replace(NODE_MODULES_REGEX, '');

    if (dependency === rootContract) {
      return `// Root file: ${filePath}\n\n` + sourceWithCommentedImports;
    }

    const sourceWithCommentedPragmas = sourceWithCommentedImports.replace(PRAGMA_SOLIDITY_REGEX, '// pragma solidity');
    return `// Dependency file: ${filePath}\n\n` + sourceWithCommentedPragmas + '\n\n';
  };
}

function findUniqueLicences(flattenContracts: string): string[] {
  const LICENCE_REGEX = /^\s*\/\/\s*SPDX-License-Identifier:(.*)$/mg;

  const licences = new Set<string>();
  let match;
  while (true) {
    match = LICENCE_REGEX.exec(flattenContracts);
    if (!match) {
      break;
    }
    licences.add(match[1].trim());
  }
  return [...licences];
}

export function normalizeSpdxLicenceIdentifiers(flattenContracts: string, contractName: string) {
  const LICENCE_REGEX = /^\s*\/\/\s*SPDX-License-Identifier:(.*)$/mg;
  const uniqueLicences = findUniqueLicences(flattenContracts);
  if (uniqueLicences.length > 1) {
    console.warn(`WARNING contract ${contractName}: multiple licences found: ${uniqueLicences.join(', ')}.
  Solidity compiler does not allow more than one licence. Licence selected: ${uniqueLicences}
    `);
  }

  const firstLicence = LICENCE_REGEX.exec(flattenContracts);
  if (!firstLicence) {
    return flattenContracts;
  }

  const normalizedContract = flattenContracts.replace(LICENCE_REGEX, '');
  return insert(normalizedContract, firstLicence[0], firstLicence.index);
}
