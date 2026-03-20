"use client";

import { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { TableBadge, type TableBadgeTone } from "@/components/ui/table-badge";

import { Edit3, FolderOpen, Users, Calendar, MapPin } from "lucide-react";
import { toast } from "sonner";
import { DataTableColumnHeader } from "@/components/tests/data-table-column-header";
import { UUIDField } from "@/components/ui/uuid-field";

export interface ProjectMember {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  status: "active" | "archived" | "deleted";
  membersCount: number;
  members?: ProjectMember[];
  createdAt: string;
  isDefault: boolean;
}

const getStatusBadgeTone = (status: string): TableBadgeTone => {
  switch (status) {
    case "active":
      return "success";
    case "archived":
      return "warning";
    case "deleted":
      return "danger";
    default:
      return "slate";
  }
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  const formattedDate = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const formattedTime = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return { formattedDate, formattedTime };
};

export function createProjectColumns(
  onEditProject?: (project: Project) => void,
  canManageProject?: boolean,
  onManageLocations?: (project: Project) => void
): ColumnDef<Project>[] {
  return [
    {
      accessorKey: "id",
      header: ({ column }) => (
        <DataTableColumnHeader
          className="pl-1"
          column={column}
          title="Project ID"
        />
      ),
      cell: ({ row }) => {
        const id = row.getValue("id") as string;
        return (
          <div className="flex items-center h-10">
            <UUIDField
              value={id}
              maxLength={8}
              onCopy={() => toast.success("Project ID copied to clipboard")}
            />
          </div>
        );
      },
      enableSorting: false,
      enableHiding: false,
    },
    {
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Project" />
      ),
      cell: ({ row }) => {
        const project = row.original;

        return (
          <div className="flex items-center h-10 min-w-[200px]">
            <div className="flex items-center gap-2.5">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                  <FolderOpen className="h-4 w-4 text-blue-600" />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground flex items-center gap-2">
                  <span className="truncate">{project.name}</span>
                  {project.isDefault && (
                    <TableBadge compact>
                      Default
                    </TableBadge>
                  )}
                </div>
                {project.description && (
                  <div className="text-xs text-muted-foreground truncate mt-0.5">
                    {project.description}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      },
      filterFn: (row, id, value) => {
        const project = row.getValue(id) as string;
        const description = row.original.description || "";
        const searchText = `${project} ${description}`;
        return searchText.toLowerCase().includes(value.toLowerCase());
      },
    },
    {
      accessorKey: "status",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => {
        const status = row.getValue("status") as string;

        return (
          <div className="flex items-center h-10">
            <TableBadge tone={getStatusBadgeTone(status)} className="capitalize">
              {status}
            </TableBadge>
          </div>
        );
      },
      filterFn: (row, id, value) => {
        return value.includes(row.getValue(id));
      },
    },
    {
      accessorKey: "membersCount",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Members" />
      ),
      cell: ({ row }) => {
        const project = row.original;
        const count = project.membersCount;
        const members = project.members || [];

        // Show up to 3 member avatars, then +X more
        const displayMembers = members.slice(0, 3);
        const remainingCount = Math.max(0, count - displayMembers.length);

        return (
          <div className="flex items-center h-10 gap-2">
            <div className="flex items-center">
              {displayMembers.length > 0 ? (
                <>
                  <div className="flex -space-x-2">
                    {displayMembers.map((member, index) => (
                      <div
                        key={member.id}
                        className="w-6 h-6 rounded-full bg-blue-100 border-2 border-background flex items-center justify-center text-xs font-medium text-blue-600"
                        title={`${member.name} (${member.role})`}
                        style={{ zIndex: displayMembers.length - index }}
                      >
                        {member.name.charAt(0).toUpperCase()}
                      </div>
                    ))}
                    {remainingCount > 0 && (
                      <div
                        className="w-6 h-6 rounded-full bg-gray-100 border-2 border-background flex items-center justify-center text-xs font-medium text-gray-600"
                        title={`+${remainingCount} more member${remainingCount > 1 ? "s" : ""}`}
                      >
                        +{remainingCount}
                      </div>
                    )}
                  </div>
                  <span className="ml-2 text-sm text-muted-foreground">
                    {count} member{count !== 1 ? "s" : ""}
                  </span>
                </>
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="ml-1 text-sm text-muted-foreground">
                    {count} member{count !== 1 ? "s" : ""}
                  </span>
                </>
              )}
            </div>
          </div>
        );
      },
    },
    {
      accessorKey: "createdAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Created" />
      ),
      cell: ({ row }) => {
        const { formattedDate, formattedTime } = formatDate(
          row.getValue("createdAt")
        );

        return (
          <div className="flex items-center h-10 text-sm">
            <Calendar className="h-3.5 w-3.5 mr-1 text-muted-foreground" />
            <span>{formattedDate}</span>
            <span className="text-muted-foreground ml-1 text-xs">
              {formattedTime}
            </span>
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => {
        const project = row.original;

        if (!canManageProject) {
          return (
            <div className="flex items-center h-10">
              <span className="text-xs text-muted-foreground">View only</span>
            </div>
          );
        }

        return (
          <div className="flex items-center h-10 gap-1">
            {onManageLocations && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-emerald-600 bg-emerald-500/10 hover:bg-emerald-500/20 hover:text-emerald-700 dark:text-emerald-400 dark:bg-emerald-500/10 dark:hover:bg-emerald-500/20 dark:hover:text-emerald-300"
                onClick={() => onManageLocations(project)}
                title="Location restrictions"
              >
                <MapPin className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-blue-600 bg-blue-500/10 hover:bg-blue-500/20 hover:text-blue-700 dark:text-blue-400 dark:bg-blue-500/10 dark:hover:bg-blue-500/20 dark:hover:text-blue-300"
              onClick={() => {
                if (onEditProject) {
                  onEditProject(project);
                }
              }}
            >
              <Edit3 className="h-4 w-4" />
            </Button>
          </div>
        );
      },
    },
  ];
}
