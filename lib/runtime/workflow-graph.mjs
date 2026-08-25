export class WorkflowGraph {
  #store;

  constructor(store) {
    if (!store) throw new Error('WorkflowGraph requires store');
    this.#store = store;
  }

  create(workflowRunId, nodes) {
    const ids = new Set(nodes.map((node) => node.node_id));
    if (ids.size !== nodes.length) throw new Error('workflow graph node IDs must be unique');
    for (const node of nodes) {
      for (const dependency of node.depends_on ?? []) {
        if (!ids.has(dependency)) throw new Error(`unknown dependency ${dependency}`);
        if (dependency === node.node_id) throw new Error(`node ${node.node_id} cannot depend on itself`);
      }
    }
    const dependencies = new Map(nodes.map((node) => [node.node_id, node.depends_on ?? []]));
    const visiting = new Set();
    const visited = new Set();
    const visit = (nodeId) => {
      if (visiting.has(nodeId)) throw new Error('workflow graph contains a cycle');
      if (visited.has(nodeId)) return;
      visiting.add(nodeId);
      for (const dependency of dependencies.get(nodeId)) visit(dependency);
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    for (const nodeId of ids) visit(nodeId);
    for (const node of nodes) {
      this.#store.saveWorkflowNode({
        workflow_run_id: workflowRunId,
        node_id: node.node_id,
        task: node.task,
        depends_on: node.depends_on ?? [],
        status: 'PENDING'
      });
    }
  }

  ready(workflowRunId) {
    const nodes = this.#store.listWorkflowNodes(workflowRunId);
    const byId = new Map(nodes.map((node) => [node.node_id, node]));
    return nodes.filter((node) => node.status === 'PENDING' && node.depends_on.every((dependency) => {
      const parent = byId.get(dependency);
      return parent?.status === 'COMPLETED' && parent.result?.status === 'PASS';
    }));
  }

  complete(workflowRunId, nodeId, result) {
    const node = this.#store.listWorkflowNodes(workflowRunId).find((item) => item.node_id === nodeId);
    if (!node) throw new Error(`unknown workflow node: ${nodeId}`);
    if (node.status !== 'PENDING') throw new Error(`workflow node ${nodeId} is already ${node.status}`);
    const completed = { ...node, status: 'COMPLETED', result };
    this.#store.saveWorkflowNode(completed);
    return completed;
  }
}
