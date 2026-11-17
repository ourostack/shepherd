// Answers for the pretend app in test/fake-app.mjs: the sidebar, projects, creating sessions, sending, answering questions and
// plans, automations, workflows and showing a session. Each answer carries the request's id, as the app's own frames do.
// refuse: session ids whose sends the app refuses. Nothing here touches a real app.
export const WORKSPACE_SESSION = 'ws-session-1111-2222-3333-444444444444';
export const CHAT_SESSION = 'chat-session-1111-2222-3333-444444444444';

export function copilotReplies({ workspaces = [], chats = [], projects = [], refuse = [] } = {}) {
  return (m) => {
    const r = m.request_id;
    switch (m.type) {
      case 'list_workspaces': return [{ type: 'workspace_list', workspaces }];
      case 'list_general_chat_sessions': return [{ type: 'general_chat_sessions_list', sessions: chats }];
      case 'list_projects': return [{ type: 'project_list', request_id: r, projects }];
      case 'create_session': return [{ type: 'session_created', request_id: r, session_id: m.workspace_id ? WORKSPACE_SESSION : CHAT_SESSION, workspace_id: m.workspace_id ?? null }];
      case 'create_worktree_workspace': return [{ type: 'workspace_created', request_id: r, workspace: { id: 'w-new', displayPath: '/work/new-lane' } }];
      case 'rename_session': return [{ type: 'session_title_updated', session_id: m.session_id }];
      case 'set_session_mode': return [{ type: 'session_mode_result', session_id: m.session_id }];
      case 'send_message':
        if (refuse.includes(m.session_id)) return [{ type: 'error', request_id: r, message: `${m.session_id} is archived` }];
        return [{ type: 'session_message_sent', request_id: r, session_id: m.session_id, message_id: 'msg-1' }];
      case 'respond_to_user_input': return [{ type: 'user_input_resolved', request_id: m.request_id, session_id: m.session_id }];
      case 'respond_to_exit_plan_mode': return [{ type: 'exit_plan_mode_resolved', request_id: r }];
      case 'list_owned_session_automations': return [{ type: 'owned_session_automations_result', request_id: r, automations: [{ id: 'auto-1' }], legacy_schedules: [] }];
      case 'save_session_automation': return [{ type: 'session_automation_mutation_result', request_id: r, automation: { id: 'auto-1', name: m.name ?? null } }];
      case 'cancel_session_automation': return [{ type: 'session_automation_mutation_result', request_id: r }];
      case 'list_workflows': return [{ type: 'workflow_list', request_id: r, tasks: [{ id: 'wf-1', name: 'Nightly' }] }];
      case 'run_workflow_now': return [{ type: 'workflow_run_started', request_id: r, run: { id: 'run-1' } }];
      case 'handle_deep_link': return [{ type: 'deep_link_received', request_id: r }];
      default: return null;
    }
  };
}
