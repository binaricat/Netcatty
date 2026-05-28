export type TreePathsState = {
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  errorPaths: Set<string>;
};

export type TreePathsAction =
  | { type: 'START_LOADING'; path: string }
  | { type: 'FINISH_LOADING'; path: string }
  | { type: 'LOAD_ERROR'; path: string }
  | { type: 'EXPAND'; path: string }
  | { type: 'COLLAPSE'; path: string }
  | { type: 'RESET' };

export const INITIAL_TREE_PATHS_STATE: TreePathsState = {
  expandedPaths: new Set(),
  loadingPaths: new Set(),
  errorPaths: new Set(),
};

export function treePathsReducer(state: TreePathsState, action: TreePathsAction): TreePathsState {
  switch (action.type) {
    case 'START_LOADING': {
      const loadingPaths = new Set(state.loadingPaths);
      loadingPaths.add(action.path);
      const errorPaths = new Set(state.errorPaths);
      errorPaths.delete(action.path);
      return { ...state, loadingPaths, errorPaths };
    }
    case 'FINISH_LOADING': {
      const loadingPaths = new Set(state.loadingPaths);
      loadingPaths.delete(action.path);
      return { ...state, loadingPaths };
    }
    case 'LOAD_ERROR': {
      const loadingPaths = new Set(state.loadingPaths);
      loadingPaths.delete(action.path);
      const errorPaths = new Set(state.errorPaths);
      errorPaths.add(action.path);
      return { ...state, loadingPaths, errorPaths };
    }
    case 'EXPAND': {
      const expandedPaths = new Set(state.expandedPaths);
      expandedPaths.add(action.path);
      return { ...state, expandedPaths };
    }
    case 'COLLAPSE': {
      const expandedPaths = new Set(state.expandedPaths);
      expandedPaths.delete(action.path);
      return { ...state, expandedPaths };
    }
    case 'RESET':
      return INITIAL_TREE_PATHS_STATE;
    default:
      return state;
  }
}
