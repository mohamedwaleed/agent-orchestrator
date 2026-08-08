import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Plan, Task } from "@orchestrator/types";

interface ApprovalGateProps {
  plan: Plan;
  onApprove: (plan: Plan) => void;
  onEditTask: (taskId: string) => void; // opens $EDITOR
}

/**
 * ApprovalGate — TUI for reviewing the Plan before execution.
 * Navigation and adapter assignment via keypresses.
 * Content edits (e.g., modifying a Task Prompt) open the user's $EDITOR.
 */
export function ApprovalGate({ plan, onApprove, onEditTask }: ApprovalGateProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const tasks = plan.tasks;

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(tasks.length - 1, i + 1));
    } else if (input === "e") {
      onEditTask(tasks[selectedIndex].id);
    } else if (input === "y") {
      onApprove(plan);
    } else if (input === "n") {
      process.exit(0);
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Approval Gate — Review Plan</Text>
      </Box>
      <Text dimColor>↑↓ navigate  |  e: edit prompt ($EDITOR)  |  y: approve  |  n: cancel</Text>
      <Box marginTop={1} flexDirection="column">
        {tasks.map((task, i) => (
          <TaskPreview key={task.id} task={task} selected={i === selectedIndex} />
        ))}
      </Box>
    </Box>
  );
}

function TaskPreview({ task, selected }: { task: Task; selected: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={selected ? "cyan" : "white"}>
          {selected ? "▶" : " "} {task.title}
        </Text>
        <Text dimColor> [Wave {task.wave + 1}] [{task.adapter}]</Text>
      </Box>
      {task.sizeWarning && (
        <Text color="yellow">  ⚠ {task.sizeWarning}</Text>
      )}
      {task.dependencies.length > 0 && (
        <Text dimColor>  depends on: {task.dependencies.join(", ")}</Text>
      )}
    </Box>
  );
}
