#!/usr/bin/env ruby
# frozen_string_literal: true

require 'open3'
require 'psych'

abort "usage: #{$PROGRAM_NAME} ACTION_YML..." if ARGV.empty?


def validate(node, path, location = '$')
  case node
  when Hash
    node.each do |key, value|
      child = "#{location}.#{key}"
      if key == 'run'
        abort "#{path}: #{child} must be a string" unless value.is_a?(String)

        _output, error, status = Open3.capture3('bash', '-n', stdin_data: value)
        abort "#{path}: #{child} has invalid bash syntax:\n#{error}" unless status.success?
      else
        validate(value, path, child)
      end
    end
  when Array
    node.each_with_index { |value, index| validate(value, path, "#{location}[#{index}]") }
  end
end

ARGV.each do |path|
  document = Psych.safe_load(File.read(path), aliases: false)
  abort "#{path}: document must be a mapping" unless document.is_a?(Hash)

  validate(document, path)
end
