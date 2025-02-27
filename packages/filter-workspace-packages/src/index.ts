import findWorkspacePackages, { Project } from '@pnpm/find-workspace-packages'
import matcher from '@pnpm/matcher'
import isSubdir = require('is-subdir')
import createPkgGraph, { Package, PackageNode } from 'pkgs-graph'
import R = require('ramda')
import getChangedPkgs from './getChangedPackages'
import parsePackageSelector, { PackageSelector } from './parsePackageSelector'

export { parsePackageSelector, PackageSelector }

export interface PackageGraph<T> {
  [id: string]: PackageNode<T>,
}

interface Graph {
  [nodeId: string]: string[],
}

export async function readProjects (
  workspaceDir: string,
  pkgSelectors: PackageSelector[],
) {
  const allProjects = await findWorkspacePackages(workspaceDir, {})
  const selectedProjectsGraph = await filterPkgsBySelectorObjects(
    allProjects,
    pkgSelectors,
    {
      workspaceDir,
    },
  )
  return { allProjects, selectedProjectsGraph }
}

export async function filterPackages<T> (
  pkgs: Array<Package & T>,
  filter: string[],
  opts: {
    prefix: string,
    workspaceDir: string,
  },
): Promise<PackageGraph<T>> {
  const packageSelectors = filter.
    map((f) => parsePackageSelector(f, opts.prefix))

  return filterPkgsBySelectorObjects(pkgs, packageSelectors, opts)
}

export async function filterPkgsBySelectorObjects<T> (
  pkgs: Array<Package & T>,
  packageSelectors: PackageSelector[],
  opts: {
    workspaceDir: string,
  },
): Promise<PackageGraph<T>> {
  const { graph } = createPkgGraph<T>(pkgs)
  if (packageSelectors && packageSelectors.length) {
    return filterGraph(graph, packageSelectors, {
      workspaceDir: opts.workspaceDir,
    })
  } else {
    return graph
  }
}

export default async function filterGraph<T> (
  pkgGraph: PackageGraph<T>,
  packageSelectors: PackageSelector[],
  opts: {
    workspaceDir: string,
  },
): Promise<PackageGraph<T>> {
  const cherryPickedPackages = [] as string[]
  const walkedDependencies = new Set<string>()
  const walkedDependents = new Set<string>()
  const graph = pkgGraphToGraph(pkgGraph)
  let reversedGraph: Graph | undefined
  for (const selector of packageSelectors) {
    let entryPackages: string[] | null = null
    if (selector.diff) {
      entryPackages = await getChangedPkgs(Object.keys(pkgGraph),
        selector.diff, { workspaceDir: selector.parentDir ?? opts.workspaceDir })
    } else if (selector.parentDir) {
      entryPackages = matchPackagesByPath(pkgGraph, selector.parentDir)
    }
    if (selector.namePattern) {
      if (!entryPackages) {
        entryPackages = matchPackages(pkgGraph, selector.namePattern)
      } else {
        entryPackages = matchPackages(R.pick(entryPackages, pkgGraph), selector.namePattern)
      }
    }

    if (!entryPackages) {
      throw new Error(`Unsupported package selector: ${JSON.stringify(selector)}`)
    }

    if (selector.includeDependencies) {
      pickSubgraph(graph, entryPackages, walkedDependencies, { includeRoot: !selector.excludeSelf })
    }
    if (selector.includeDependents) {
      if (!reversedGraph) {
        reversedGraph = reverseGraph(graph)
      }
      pickSubgraph(reversedGraph, entryPackages, walkedDependents, { includeRoot: !selector.excludeSelf })
    }
    if (!selector.includeDependencies && !selector.includeDependents) {
      Array.prototype.push.apply(cherryPickedPackages, entryPackages)
    }
  }
  const walked = new Set([...walkedDependencies, ...walkedDependents])
  cherryPickedPackages.forEach((cherryPickedPackage) => walked.add(cherryPickedPackage))
  return R.pick(Array.from(walked), pkgGraph)
}

function pkgGraphToGraph<T> (pkgGraph: PackageGraph<T>): Graph {
  const graph: Graph = {}
  Object.keys(pkgGraph).forEach((nodeId) => {
    graph[nodeId] = pkgGraph[nodeId].dependencies
  })
  return graph
}

function reverseGraph (graph: Graph): Graph {
  const reversedGraph: Graph = {}
  Object.keys(graph).forEach((dependentNodeId) => {
    graph[dependentNodeId].forEach((dependencyNodeId) => {
      if (!reversedGraph[dependencyNodeId]) {
        reversedGraph[dependencyNodeId] = [dependentNodeId]
      } else {
        reversedGraph[dependencyNodeId].push(dependentNodeId)
      }
    })
  })
  return reversedGraph
}

function matchPackages<T> (
  graph: PackageGraph<T>,
  pattern: string,
) {
  const match = matcher(pattern)
  return Object.keys(graph).filter((id) => graph[id].package.manifest.name && match(graph[id].package.manifest.name!))
}

function matchPackagesByPath<T> (
  graph: PackageGraph<T>,
  pathStartsWith: string,
) {
  return Object.keys(graph).filter((parentDir) => isSubdir(pathStartsWith, parentDir))
}

function pickSubgraph (
  graph: Graph,
  nextNodeIds: string[],
  walked: Set<string>,
  opts: {
    includeRoot: boolean,
  },
) {
  for (const nextNodeId of nextNodeIds) {
    if (!walked.has(nextNodeId)) {
      if (opts.includeRoot) {
        walked.add(nextNodeId)
      }

      if (graph[nextNodeId]) pickSubgraph(graph, graph[nextNodeId], walked, { includeRoot: true })
    }
  }
}
