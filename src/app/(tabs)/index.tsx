import { useState, useMemo, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, TextInput } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Button, useThemeColor } from 'heroui-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useApp } from '../../context/AppContext';
import { AddProjectDialog } from '../../components/AddProjectDialog';

export default function SecretsTab() {
  const { projects, loadProjects, isLoading } = useApp();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [themeAccent, themeMuted] = useThemeColor(['accent', 'muted']);

  useFocusEffect(
    useCallback(() => {
      loadProjects();
    }, [loadProjects])
  );

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const query = searchQuery.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(query));
  }, [projects, searchQuery]);

  const handleProjectPress = (projectId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({
      pathname: '/project/[id]',
      params: { id: projectId },
    });
  };

  return (
    <View className="flex-1 bg-background">
      <View className="px-5 pt-14 pb-3">
        <Text className="text-3xl font-bold text-foreground">My Projects</Text>
        <Text className="text-sm text-muted mt-1">
          {projects.length} {projects.length === 1 ? 'project' : 'projects'} in your vault
        </Text>
      </View>

      <ScrollView className="flex-1 px-5" showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View className="items-center justify-center" style={{ minHeight: 300 }}>
            <ActivityIndicator size="large" color={themeAccent} />
          </View>
        ) : projects.length === 0 ? (
          <View className="items-center justify-center px-6" style={{ minHeight: 400 }}>
            <View className="w-24 h-24 rounded-full bg-surface items-center justify-center mb-6">
              <Ionicons name="shield-checkmark-outline" size={48} color={themeAccent} />
            </View>
            <Text className="text-xl font-bold text-foreground text-center">Your vault is empty</Text>
            <Text className="text-muted mt-2 text-center leading-5">
              Projects help you organize secrets by app, environment, or team. Create your first one to get started.
            </Text>
            <Button
              variant="primary"
              size="md"
              onPress={() => setShowAddDialog(true)}
              className="mt-6"
            >
              <Ionicons name="add" size={18} />
              <Button.Label>Create First Project</Button.Label>
            </Button>
          </View>
        ) : (
          <View className="gap-1 pb-28">
            {projects.length > 0 && (
              <View className="mb-3">
                <View className="flex-row items-center bg-surface rounded-xl px-3 gap-2">
                  <Ionicons name="search" size={18} color={themeMuted} />
                  <TextInput
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder="Search projects..."
                    placeholderTextColor={themeMuted}
                    className="flex-1 py-3 text-foreground"
                  />
                  {searchQuery.length > 0 && (
                    <Pressable onPress={() => setSearchQuery('')}>
                      <Ionicons name="close-circle" size={18} color={themeMuted} />
                    </Pressable>
                  )}
                </View>
              </View>
            )}

            <Text className="text-xs font-semibold text-muted uppercase tracking-wider mt-2 mb-2 px-1">
              All Projects
            </Text>

            {filteredProjects.length === 0 && searchQuery.trim() ? (
              <View className="items-center justify-center py-12">
                <Ionicons name="search-outline" size={36} color={themeMuted} />
                <Text className="text-sm text-muted mt-3 text-center">
                  No projects matching &ldquo;{searchQuery}&rdquo;
                </Text>
              </View>
            ) : (
              <View className="bg-surface rounded-xl overflow-hidden">
                {filteredProjects.map((project) => (
                  <Pressable
                    key={project.id}
                    onPress={() => handleProjectPress(project.id)}
                    className="flex-row items-center justify-between px-4 py-4"
                  >
                    <View className="flex-row items-center gap-3 flex-1">
                      <Ionicons name="folder-outline" size={20} color={themeAccent} />
                      <View className="flex-1">
                        <Text className="text-base text-foreground">{project.name}</Text>
                        <Text className="text-xs text-muted">
                          {new Date(project.createdAt).toLocaleDateString()}
                        </Text>
                      </View>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={themeMuted} />
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {projects.length > 0 && (
        <View className="absolute bottom-8 right-6">
          <Button
            variant="primary"
            size="lg"
            isIconOnly
            onPress={() => setShowAddDialog(true)}
          >
            <Ionicons name="add" size={24} />
          </Button>
        </View>
      )}

      <AddProjectDialog
        isOpen={showAddDialog}
        onOpenChange={setShowAddDialog}
      />
    </View>
  );
}
